/**
 * Location WebSocket Handler
 *
 * Events:
 * Client → Server:
 *   location:batch — send a batch of GPS points for the active session
 *   location:join_area — join a geographic room to receive nearby territory updates
 *   location:leave_area — leave a geographic room
 *
 * Server → Client:
 *   location:batch_ack — acknowledgment with validation result
 *   territory:nearby — territory updates within the user's current cell
 */

import { Server as SocketIOServer, Socket } from 'socket.io';
import { z } from 'zod';
import { gpsService, GpsBatch } from '../services/gps.service';
import { toGeohash } from '../../utils/geo.utils';
import { logger } from '../../utils/logger';
import { redis } from '../../config/redis';

// Import service here to avoid circular deps — use a getter pattern
import { gpsService as gps } from '../../services/gps.service';

const batchSchema = z.object({
  sessionId: z.string().uuid(),
  points: z.array(z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    altitude: z.number().optional(),
    accuracy: z.number().optional(),
    speed: z.number().optional(),
    timestamp: z.number(),
  })).min(1).max(50),
  isMockLocationEnabled: z.boolean().optional(),
});

export function handleLocationUpdate(io: SocketIOServer, socket: Socket): void {
  const userId = socket.user.sub;

  /**
   * Process incoming GPS batch
   * Rate-limited server-side by checking session state in Redis
   */
  socket.on('location:batch', async (data: unknown, callback?: (ack: unknown) => void) => {
    try {
      const parsed = batchSchema.safeParse(data);
      if (!parsed.success) {
        callback?.({ error: 'Invalid batch format', details: parsed.error.flatten() });
        return;
      }

      const batch: GpsBatch = {
        ...parsed.data,
        userId,
      };

      const result = await gps.processBatch(batch);

      // Acknowledge to sender
      callback?.({ ok: true, ...result });

      if (result.sessionInvalidated) {
        socket.emit('session:invalidated', {
          sessionId: batch.sessionId,
          reason: 'Anti-cheat violations exceeded threshold',
        });
        return;
      }

      // Broadcast last known position to users in the same geographic cell
      // Use last valid point's geohash for room routing
      const lastPoint = parsed.data.points[parsed.data.points.length - 1];
      const geohash = toGeohash(lastPoint.latitude, lastPoint.longitude, 3);

      // Update live player position in Redis (for nearby player awareness)
      await redis.setex(
        `player:${userId}:position`,
        10, // expire after 10s of inactivity
        JSON.stringify({ lat: lastPoint.latitude, lng: lastPoint.longitude, geohash })
      );

      // Notify others in the same cell of this player's presence (not exact location — privacy)
      socket.to(`geo:${geohash}`).emit('player:nearby', {
        userId,
        geohash, // coarse location only
      });

    } catch (err) {
      logger.error('location:batch error', { userId, error: (err as Error).message });
      callback?.({ error: 'Internal server error' });
    }
  });

  /**
   * Join a geographic room to receive territory updates for that area
   * Called when map viewport changes
   */
  socket.on('location:join_area', (data: { geohash: string }) => {
    if (typeof data?.geohash !== 'string' || data.geohash.length > 6) return;

    const room = `geo:${data.geohash}`;
    socket.join(room);
    logger.debug('Player joined geo room', { userId, room });
  });

  socket.on('location:leave_area', (data: { geohash: string }) => {
    if (typeof data?.geohash !== 'string') return;
    socket.leave(`geo:${data.geohash}`);
  });
}
