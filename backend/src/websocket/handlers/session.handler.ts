/**
 * Session WebSocket Handler
 *
 * Events:
 * Client → Server:
 *   session:start  — begin a GPS tracking session
 *   session:end    — finalize session, generate polygon, commit territory
 *   session:cancel — abandon session without committing
 *
 * Server → Client:
 *   session:started     — confirmed with sessionId
 *   session:finalized   — territory committed, with steal/lose/split events
 *   session:error       — error during session operation
 */

import { Server as SocketIOServer, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { query } from '../../config/database';
import { redis, CacheKey } from '../../config/redis';
import { gpsService } from '../../services/gps.service';
import { antiCheatService } from '../../services/anticheat.service';
import { territoryService } from '../../services/territory.service';
import { logger } from '../../utils/logger';

const endSessionSchema = z.object({
  sessionId: z.string().uuid(),
  city: z.string().optional(),
  country: z.string().optional(),
});

export function handleSessionEvents(io: SocketIOServer, socket: Socket): void {
  const userId = socket.user.sub;

  socket.on('session:start', async (data: unknown, callback?: (ack: unknown) => void) => {
    try {
      // Check if user already has an active session
      const existingSession = await redis.get(CacheKey.activeSession(userId));
      if (existingSession) {
        callback?.({ error: 'You already have an active session', sessionId: existingSession });
        return;
      }

      const sessionId = uuidv4();

      // Create session record in DB
      await query(`
        INSERT INTO sessions (id, user_id, status)
        VALUES ($1, $2, 'active')
      `, [sessionId, userId]);

      // Mark as active in Redis (TTL: 4 hours max session length)
      await redis.setex(CacheKey.activeSession(userId), 4 * 3600, sessionId);

      callback?.({ ok: true, sessionId });
      logger.info('Session started', { userId, sessionId });

    } catch (err) {
      logger.error('session:start error', { userId, error: (err as Error).message });
      callback?.({ error: 'Failed to start session' });
    }
  });

  socket.on('session:end', async (data: unknown, callback?: (ack: unknown) => void) => {
    try {
      const parsed = endSessionSchema.safeParse(data);
      if (!parsed.success) {
        callback?.({ error: 'Invalid session data' });
        return;
      }

      const { sessionId, city, country } = parsed.data;

      // Verify session belongs to this user
      const activeSessionId = await redis.get(CacheKey.activeSession(userId));
      if (activeSessionId !== sessionId) {
        callback?.({ error: 'Session not found or does not belong to you' });
        return;
      }

      // Finalize GPS points → polygon
      const { polygon, pointCount, distanceM } = await gpsService.finalizeSession(sessionId);

      if (!polygon || pointCount < 3) {
        await finalizeSessionRecord(sessionId, userId, distanceM, 0, 0, 0, 'completed');
        await redis.del(CacheKey.activeSession(userId));
        callback?.({ ok: true, polygon: null, message: 'Not enough GPS points to generate territory' });
        return;
      }

      // Validate polygon against anti-cheat rules
      const polygonAreaM2 = estimatePolygonArea(polygon);
      const validation = await antiCheatService.validateFinalPolygon(sessionId, polygonAreaM2);

      if (!validation.valid) {
        await finalizeSessionRecord(sessionId, userId, distanceM, 0, 0, 0, 'invalidated');
        await redis.del(CacheKey.activeSession(userId));
        callback?.({ ok: false, error: validation.reason });
        return;
      }

      // Commit polygon to territory system
      const commitResult = await territoryService.commitPolygon({
        userId,
        geoJsonPolygon: polygon,
        sessionId,
        city,
        country,
      });

      // Calculate area stolen/lost from events
      const areaStolen = commitResult.events
        .filter(e => e.type === 'steal')
        .reduce((sum, e) => sum + e.intersectionAreaM2, 0);
      const areaLost = commitResult.events
        .filter(e => e.type === 'lose')
        .reduce((sum, e) => sum + e.intersectionAreaM2, 0);

      await finalizeSessionRecord(
        sessionId, userId, distanceM,
        commitResult.areaM2, areaStolen, areaLost, 'completed'
      );

      await redis.del(CacheKey.activeSession(userId));

      // Respond to session owner
      callback?.({
        ok: true,
        territoryId: commitResult.territoryId,
        areaM2: commitResult.areaM2,
        distanceM,
        events: commitResult.events,
        polygon,
      });

      // Broadcast steal events to affected users
      for (const event of commitResult.events) {
        if (event.type === 'steal') {
          io.to(`user:${event.defenderUserId}`).emit('territory:stolen_from', {
            byUserId: userId,
            areaLostM2: event.intersectionAreaM2,
          });
        }
      }

      logger.info('Session ended successfully', {
        userId, sessionId, areaM2: commitResult.areaM2, events: commitResult.events.length,
      });

    } catch (err) {
      logger.error('session:end error', { userId, error: (err as Error).message });
      callback?.({ error: 'Failed to finalize session' });
    }
  });

  socket.on('session:cancel', async (data: unknown, callback?: (ack: unknown) => void) => {
    try {
      const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(data);

      const activeSessionId = await redis.get(CacheKey.activeSession(userId));
      if (activeSessionId === sessionId) {
        await redis.del(CacheKey.activeSession(userId));
        await query(
          `UPDATE sessions SET status = 'cancelled', ended_at = NOW() WHERE id = $1`,
          [sessionId]
        );
      }

      // Clean up GPS accumulator
      await redis.del(`session:${sessionId}:gps_points`);
      callback?.({ ok: true });

    } catch (err) {
      callback?.({ error: 'Failed to cancel session' });
    }
  });
}

async function finalizeSessionRecord(
  sessionId: string,
  userId: string,
  distanceM: number,
  areaCapturedM2: number,
  areaStolen: number,
  areaLost: number,
  status: string
): Promise<void> {
  await query(`
    UPDATE sessions
    SET
      ended_at = NOW(),
      status = $3,
      distance_m = $4,
      area_captured_m2 = $5,
      area_stolen_m2 = $6,
      area_lost_m2 = $7
    WHERE id = $1 AND user_id = $2
  `, [sessionId, userId, status, distanceM, areaCapturedM2, areaStolen, areaLost]);
}

/**
 * Quick polygon area estimate in m² (GeoJSON polygon)
 * PostGIS does the authoritative calculation — this is just for validation gating
 */
function estimatePolygonArea(polygon: { coordinates: [number, number][][] }): number {
  const ring = polygon.coordinates[0];
  if (!ring || ring.length < 3) return 0;

  // Shoelace formula in approximate meters
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    area += (x1 * 111320) * (y2 * 111320) - (x2 * 111320) * (y1 * 111320);
  }
  return Math.abs(area / 2);
}
