/**
 * GPS Batching Service
 *
 * Strategy:
 * - Client sends GPS batches every GPS_BATCH_INTERVAL_MS (default 3s)
 * - Each batch may contain 1–GPS_MAX_BATCH_SIZE points
 * - Server validates each batch, accumulates valid points in Redis
 * - On session end, accumulated points → polygon → commit
 *
 * Why batch instead of point-by-point:
 * - Reduces WebSocket message overhead by ~20×
 * - Allows server-side smoothing and outlier removal per batch
 * - Gracefully handles brief connectivity drops (client buffers locally)
 */

import { redis, CacheKey, TTL } from '../config/redis';
import { antiCheatService } from './anticheat.service';
import { gpsPointsToPolygon, GpsPoint } from '../utils/geo.utils';
import { logger } from '../utils/logger';
import { env } from '../config/env';

export interface GpsBatch {
  sessionId: string;
  userId: string;
  points: GpsPoint[];
  isMockLocationEnabled?: boolean;
  deviceInfo?: {
    platform: 'ios' | 'android';
    appVersion: string;
  };
}

export interface BatchResult {
  accepted: number;
  rejected: number;
  sessionInvalidated: boolean;
  totalAccumulatedPoints: number;
}

const SESSION_POINTS_KEY = (sessionId: string) => `session:${sessionId}:gps_points`;

export class GpsService {
  /**
   * Process an incoming GPS batch:
   * 1. Run anti-cheat validation
   * 2. Store valid points in Redis (session accumulator)
   * 3. Return batch result to client
   */
  async processBatch(batch: GpsBatch): Promise<BatchResult> {
    // Mock location check
    const isMock = antiCheatService.detectMockLocation({
      isMockLocationEnabled: batch.isMockLocationEnabled ?? false,
      points: batch.points,
    });

    if (isMock) {
      logger.warn('Mock location detected', {
        userId: batch.userId,
        sessionId: batch.sessionId,
      });
      return { accepted: 0, rejected: batch.points.length, sessionInvalidated: true, totalAccumulatedPoints: 0 };
    }

    // Anti-cheat validation
    const result = await antiCheatService.validateBatch(
      batch.sessionId,
      batch.userId,
      batch.points
    );

    if (result.filteredPoints.length > 0) {
      await this.accumulatePoints(batch.sessionId, result.filteredPoints);
    }

    const totalPoints = await this.getAccumulatedPointCount(batch.sessionId);

    return {
      accepted: result.filteredPoints.length,
      rejected: batch.points.length - result.filteredPoints.length,
      sessionInvalidated: !result.valid,
      totalAccumulatedPoints: totalPoints,
    };
  }

  /**
   * Finalize a session: build polygon from accumulated GPS points
   */
  async finalizeSession(sessionId: string): Promise<{
    polygon: ReturnType<typeof gpsPointsToPolygon>;
    pointCount: number;
    distanceM: number;
  }> {
    const points = await this.getAccumulatedPoints(sessionId);

    if (points.length < 3) {
      return { polygon: null, pointCount: points.length, distanceM: 0 };
    }

    const polygon = gpsPointsToPolygon(points);

    // Calculate total distance
    let distanceM = 0;
    for (let i = 1; i < points.length; i++) {
      const { haversineDistance } = await import('../utils/geo.utils');
      distanceM += haversineDistance(
        points[i - 1].latitude, points[i - 1].longitude,
        points[i].latitude, points[i].longitude
      );
    }

    // Cleanup Redis session data
    await redis.del(SESSION_POINTS_KEY(sessionId));
    await redis.del(CacheKey.sessionAntiCheat(sessionId));

    return { polygon, pointCount: points.length, distanceM };
  }

  /**
   * Append validated GPS points to session accumulator in Redis
   * Uses Redis List for O(1) append and ordered storage
   */
  private async accumulatePoints(sessionId: string, points: GpsPoint[]): Promise<void> {
    const key = SESSION_POINTS_KEY(sessionId);
    const pipeline = redis.pipeline();

    for (const point of points) {
      pipeline.rpush(key, JSON.stringify(point));
    }

    // Enforce max points per session (prevent memory abuse)
    const maxPoints = env.GPS_MAX_BATCH_SIZE * 1000; // 50k points max
    pipeline.ltrim(key, -maxPoints, -1);
    pipeline.expire(key, TTL.SESSION_DATA);

    await pipeline.exec();
  }

  private async getAccumulatedPoints(sessionId: string): Promise<GpsPoint[]> {
    const key = SESSION_POINTS_KEY(sessionId);
    const raw = await redis.lrange(key, 0, -1);
    return raw.map(s => JSON.parse(s) as GpsPoint);
  }

  private async getAccumulatedPointCount(sessionId: string): Promise<number> {
    return redis.llen(SESSION_POINTS_KEY(sessionId));
  }

  /**
   * Downsample GPS points using Ramer-Douglas-Peucker algorithm
   * Reduces polygon complexity while preserving shape accuracy
   */
  static ramerDouglasPeucker(points: GpsPoint[], epsilon: number): GpsPoint[] {
    if (points.length < 3) return points;

    const start = points[0];
    const end = points[points.length - 1];
    let maxDist = 0;
    let maxIndex = 0;

    for (let i = 1; i < points.length - 1; i++) {
      const dist = perpendicularDistance(points[i], start, end);
      if (dist > maxDist) { maxDist = dist; maxIndex = i; }
    }

    if (maxDist > epsilon) {
      const left = GpsService.ramerDouglasPeucker(points.slice(0, maxIndex + 1), epsilon);
      const right = GpsService.ramerDouglasPeucker(points.slice(maxIndex), epsilon);
      return [...left.slice(0, -1), ...right];
    }

    return [start, end];
  }
}

function perpendicularDistance(point: GpsPoint, lineStart: GpsPoint, lineEnd: GpsPoint): number {
  const dx = lineEnd.longitude - lineStart.longitude;
  const dy = lineEnd.latitude - lineStart.latitude;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return 0;
  const t = ((point.longitude - lineStart.longitude) * dx +
             (point.latitude - lineStart.latitude) * dy) / (len * len);
  const nearX = lineStart.longitude + t * dx;
  const nearY = lineStart.latitude + t * dy;
  const distLng = point.longitude - nearX;
  const distLat = point.latitude - nearY;
  // Convert degrees to approximate meters
  return Math.sqrt((distLng * 111320) ** 2 + (distLat * 111320) ** 2);
}

export const gpsService = new GpsService();
