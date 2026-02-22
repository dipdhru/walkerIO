import Redis from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';

// Primary client for general caching
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
  retryStrategy: (times) => Math.min(times * 100, 3000),
});

// Duplicate client for Socket.IO adapter (pub/sub requires dedicated connections)
export const redisPub = new Redis(env.REDIS_URL, { lazyConnect: false });
export const redisSub = new Redis(env.REDIS_URL, { lazyConnect: false });

redis.on('error', (err) => logger.error('Redis error', { error: err.message }));
redis.on('connect', () => logger.info('Redis connected'));

// TTL constants (seconds)
export const TTL = {
  USER_PROFILE: 300,        // 5 minutes
  LEADERBOARD_GLOBAL: 60,   // 1 minute
  LEADERBOARD_CITY: 120,    // 2 minutes
  TERRITORY_NEARBY: 30,     // 30 seconds
  SESSION_DATA: 3600,       // 1 hour
  RATE_LIMIT_WINDOW: 900,   // 15 minutes
} as const;

// Key builders (centralized to avoid typos)
export const CacheKey = {
  userProfile: (userId: string) => `user:${userId}:profile`,
  userTotalArea: (userId: string) => `user:${userId}:total_area`,
  leaderboardGlobal: (page: number) => `leaderboard:global:${page}`,
  leaderboardCity: (city: string, page: number) => `leaderboard:city:${city}:${page}`,
  nearbyTerritories: (geohash: string) => `territories:geo:${geohash}`,
  sessionAntiCheat: (sessionId: string) => `session:${sessionId}:anticheat`,
  activeSession: (userId: string) => `user:${userId}:active_session`,
} as const;

export async function checkRedisConnection(): Promise<void> {
  await redis.ping();
  logger.info('Redis connection verified');
}
