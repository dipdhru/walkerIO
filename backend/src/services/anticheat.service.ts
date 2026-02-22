/**
 * Anti-cheat service for Walker.IO
 *
 * Strategies:
 * 1. Speed gate — GPS point-to-point speed must be below threshold
 * 2. Acceleration check — sudden velocity changes flag teleportation
 * 3. GPS jitter analysis — stationary variance vs. movement variance
 * 4. Session area cap — no single session exceeds configured max
 * 5. Violation accumulation — 3 strikes and session is invalidated
 */

import { redis, CacheKey, TTL } from '../config/redis';
import { env } from '../config/env';
import { haversineDistance, calculateSpeed, GpsPoint } from '../utils/geo.utils';
import { logger } from '../utils/logger';

export type ViolationType =
  | 'speed_exceeded'
  | 'teleportation'
  | 'gps_spoofing_suspected'
  | 'impossible_acceleration'
  | 'session_area_cap_exceeded';

export interface ValidationResult {
  valid: boolean;
  violations: Array<{ type: ViolationType; detail: string }>;
  filteredPoints: GpsPoint[];  // Points that passed validation
}

interface SessionAntiCheatState {
  violationCount: number;
  totalDistanceM: number;
  lastValidPoint: GpsPoint | null;
  invalidated: boolean;
}

export class AntiCheatService {
  private readonly MAX_SPEED_KMH = env.MAX_SPEED_KMH;           // default 50 km/h
  private readonly MAX_ACCELERATION_MS2 = 10;                     // 10 m/s² (sprint burst)
  private readonly MAX_VIOLATIONS = env.MAX_VIOLATIONS_PER_SESSION;
  private readonly MIN_POINT_ACCURACY_M = 50;                     // discard if accuracy > 50m
  private readonly MAX_JITTER_VARIANCE = 20;                      // meters

  /**
   * Validate a batch of GPS points for a session.
   * Returns filtered valid points and any violations found.
   */
  async validateBatch(
    sessionId: string,
    userId: string,
    points: GpsPoint[]
  ): Promise<ValidationResult> {
    const state = await this.getSessionState(sessionId);

    if (state.invalidated) {
      return {
        valid: false,
        violations: [{ type: 'speed_exceeded', detail: 'Session already invalidated' }],
        filteredPoints: [],
      };
    }

    const violations: ValidationResult['violations'] = [];
    const filteredPoints: GpsPoint[] = [];
    let prevPoint = state.lastValidPoint;

    for (let i = 0; i < points.length; i++) {
      const point = points[i];

      // 1. Discard low-accuracy points (GPS noise)
      if (point.accuracy !== undefined && point.accuracy > this.MIN_POINT_ACCURACY_M) {
        continue;
      }

      // 2. Skip points with future timestamps (clock manipulation)
      if (point.timestamp > Date.now() + 5000) {
        violations.push({
          type: 'gps_spoofing_suspected',
          detail: `Future timestamp: ${point.timestamp}`,
        });
        continue;
      }

      if (!prevPoint) {
        filteredPoints.push(point);
        prevPoint = point;
        continue;
      }

      const timeDeltaS = (point.timestamp - prevPoint.timestamp) / 1000;

      // 3. Ignore points that go backward in time
      if (timeDeltaS <= 0) continue;

      const distanceM = haversineDistance(
        prevPoint.latitude, prevPoint.longitude,
        point.latitude, point.longitude
      );

      const speedKmh = (distanceM / timeDeltaS) * 3.6;

      // 4. Speed check
      if (speedKmh > this.MAX_SPEED_KMH) {
        const violation = {
          type: 'speed_exceeded' as ViolationType,
          detail: `Speed ${speedKmh.toFixed(1)} km/h exceeds max ${this.MAX_SPEED_KMH} km/h`,
        };
        violations.push(violation);
        state.violationCount++;
        logger.warn('Anti-cheat: speed violation', { userId, sessionId, speedKmh });
        // Don't add this point, but don't reset prevPoint — continue from last valid
        continue;
      }

      // 5. Teleportation check — very large distance in very short time
      if (distanceM > 500 && timeDeltaS < 5) {
        const violation = {
          type: 'teleportation' as ViolationType,
          detail: `${distanceM.toFixed(0)}m in ${timeDeltaS.toFixed(1)}s`,
        };
        violations.push(violation);
        state.violationCount++;
        continue;
      }

      // 6. Acceleration check (if device reports speed)
      if (point.speed !== undefined && prevPoint.speed !== undefined) {
        const deltaSpeedMS = Math.abs(point.speed - prevPoint.speed);
        const acceleration = deltaSpeedMS / timeDeltaS;
        if (acceleration > this.MAX_ACCELERATION_MS2 && deltaSpeedMS > 5) {
          violations.push({
            type: 'impossible_acceleration',
            detail: `${acceleration.toFixed(1)} m/s² over ${timeDeltaS.toFixed(1)}s`,
          });
          state.violationCount++;
          continue;
        }
      }

      // Point passed all checks
      filteredPoints.push(point);
      state.totalDistanceM += distanceM;
      prevPoint = point;
    }

    // Update session state
    state.lastValidPoint = prevPoint;
    if (state.violationCount >= this.MAX_VIOLATIONS) {
      state.invalidated = true;
      logger.warn('Anti-cheat: session invalidated', {
        userId, sessionId, violations: state.violationCount,
      });
    }

    await this.saveSessionState(sessionId, state);

    return {
      valid: !state.invalidated,
      violations,
      filteredPoints,
    };
  }

  /**
   * Validate the final polygon from a session:
   * - Area must be within session limits
   * - Polygon must not cover impossible area for session distance
   */
  async validateFinalPolygon(
    sessionId: string,
    polygonAreaM2: number
  ): Promise<{ valid: boolean; reason?: string }> {
    const state = await this.getSessionState(sessionId);

    if (state.invalidated) {
      return { valid: false, reason: 'Session was invalidated during tracking' };
    }

    // Area cap
    if (polygonAreaM2 > env.MAX_SESSION_AREA_M2) {
      return {
        valid: false,
        reason: `Area ${polygonAreaM2.toFixed(0)}m² exceeds session cap ${env.MAX_SESSION_AREA_M2}m²`,
      };
    }

    // Sanity: polygon area cannot be more than π × (distance/2)² (max circle)
    // A person can't capture more area than the circle with their path as circumference
    const maxTheoreticalAreaM2 = Math.PI * Math.pow(state.totalDistanceM / (2 * Math.PI), 2);
    if (polygonAreaM2 > maxTheoreticalAreaM2 * 1.1) {  // 10% tolerance
      return {
        valid: false,
        reason: 'Polygon area exceeds theoretical maximum for session distance',
      };
    }

    return { valid: true };
  }

  /**
   * Detect if device is likely using mock location (client-reported flag + server heuristics)
   */
  detectMockLocation(params: {
    isMockLocationEnabled: boolean; // reported by device
    points: GpsPoint[];
  }): boolean {
    if (params.isMockLocationEnabled) return true;

    // Heuristic: real GPS has measurement variance; mock tends to produce perfectly smooth paths
    if (params.points.length < 5) return false;

    const latVariances: number[] = [];
    for (let i = 1; i < params.points.length; i++) {
      const latDelta = Math.abs(params.points[i].latitude - params.points[i - 1].latitude);
      latVariances.push(latDelta);
    }

    const mean = latVariances.reduce((a, b) => a + b, 0) / latVariances.length;
    const variance = latVariances.reduce((a, b) => a + (b - mean) ** 2, 0) / latVariances.length;

    // Suspiciously perfect GPS (variance near 0 over many points) is mock-location signature
    // Real GPS at walking speed has jitter of ~1e-6 to 1e-5 degrees
    if (variance < 1e-12 && params.points.length > 20) return true;

    return false;
  }

  private async getSessionState(sessionId: string): Promise<SessionAntiCheatState> {
    const key = CacheKey.sessionAntiCheat(sessionId);
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached) as SessionAntiCheatState;

    return {
      violationCount: 0,
      totalDistanceM: 0,
      lastValidPoint: null,
      invalidated: false,
    };
  }

  private async saveSessionState(
    sessionId: string,
    state: SessionAntiCheatState
  ): Promise<void> {
    const key = CacheKey.sessionAntiCheat(sessionId);
    await redis.setex(key, TTL.SESSION_DATA, JSON.stringify(state));
  }
}

export const antiCheatService = new AntiCheatService();
