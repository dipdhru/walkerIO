/**
 * Leaderboard Service
 *
 * Design:
 * - Redis Sorted Sets for O(log N) rank lookups
 * - Score = total_area_m2 (higher = better rank)
 * - Two sets: global + per-city
 * - Refreshed from DB every 60s via background job
 * - Real-time updates applied on territory commit
 */

import { query } from '../config/database';
import { redis, TTL } from '../config/redis';
import { logger } from '../utils/logger';

const LEADERBOARD_GLOBAL_KEY = 'lb:global';
const LEADERBOARD_CITY_KEY = (city: string) => `lb:city:${city.toLowerCase()}`;
const PAGE_SIZE = 50;

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  totalAreaM2: number;
  city: string | null;
}

export class LeaderboardService {
  /**
   * Get paginated global leaderboard from Redis sorted set
   */
  async getGlobalLeaderboard(page: number): Promise<{
    entries: LeaderboardEntry[];
    total: number;
  }> {
    const start = (page - 1) * PAGE_SIZE;
    const end = start + PAGE_SIZE - 1;

    // Redis ZREVRANGE with scores (highest area first)
    const results = await redis.zrevrange(LEADERBOARD_GLOBAL_KEY, start, end, 'WITHSCORES');

    if (results.length === 0) {
      // Cold cache — load from DB
      await this.refreshGlobalLeaderboard();
      return this.getGlobalLeaderboard(page);
    }

    const total = await redis.zcard(LEADERBOARD_GLOBAL_KEY);
    const entries = await this.hydrateEntries(results, start);

    return { entries, total };
  }

  /**
   * Get paginated city leaderboard
   */
  async getCityLeaderboard(city: string, page: number): Promise<{
    entries: LeaderboardEntry[];
    total: number;
  }> {
    const key = LEADERBOARD_CITY_KEY(city);
    const start = (page - 1) * PAGE_SIZE;
    const end = start + PAGE_SIZE - 1;

    const results = await redis.zrevrange(key, start, end, 'WITHSCORES');

    if (results.length === 0) {
      await this.refreshCityLeaderboard(city);
      const refetched = await redis.zrevrange(key, start, end, 'WITHSCORES');
      if (refetched.length === 0) return { entries: [], total: 0 };
      return {
        entries: await this.hydrateEntries(refetched, start),
        total: await redis.zcard(key),
      };
    }

    const total = await redis.zcard(key);
    const entries = await this.hydrateEntries(results, start);

    return { entries, total };
  }

  /**
   * Get a specific user's rank and surrounding context (±5 positions)
   */
  async getUserRank(userId: string): Promise<{
    globalRank: number | null;
    cityRank: number | null;
    totalAreaM2: number;
  }> {
    const [globalRank, score] = await Promise.all([
      redis.zrevrank(LEADERBOARD_GLOBAL_KEY, userId),
      redis.zscore(LEADERBOARD_GLOBAL_KEY, userId),
    ]);

    return {
      globalRank: globalRank !== null ? globalRank + 1 : null,
      cityRank: null, // lazy load — not critical path
      totalAreaM2: score !== null ? parseFloat(score) : 0,
    };
  }

  /**
   * Update a user's score in all relevant leaderboards
   * Called after territory commit — O(log N) Redis operation
   */
  async updateUserScore(userId: string, totalAreaM2: number, city?: string): Promise<void> {
    const pipeline = redis.pipeline();

    pipeline.zadd(LEADERBOARD_GLOBAL_KEY, totalAreaM2, userId);

    if (city) {
      pipeline.zadd(LEADERBOARD_CITY_KEY(city), totalAreaM2, userId);
    }

    await pipeline.exec();
    logger.debug('Leaderboard score updated', { userId, totalAreaM2, city });
  }

  /**
   * Full refresh from PostgreSQL — run as cron job every 60s
   * or on first cache miss
   */
  async refreshGlobalLeaderboard(): Promise<void> {
    const rows = await query<{
      id: string;
      total_area_m2: number;
    }>(`
      SELECT id, total_area_m2
      FROM users
      WHERE is_active = true AND total_area_m2 > 0
      ORDER BY total_area_m2 DESC
      LIMIT 10000
    `);

    if (rows.length === 0) return;

    const pipeline = redis.pipeline();
    pipeline.del(LEADERBOARD_GLOBAL_KEY);

    // Add all in one pipeline batch
    const args: (string | number)[] = [];
    for (const row of rows) {
      args.push(row.total_area_m2, row.id);
    }
    pipeline.zadd(LEADERBOARD_GLOBAL_KEY, ...args);
    pipeline.expire(LEADERBOARD_GLOBAL_KEY, TTL.LEADERBOARD_GLOBAL);

    await pipeline.exec();
    logger.info('Global leaderboard refreshed', { count: rows.length });
  }

  async refreshCityLeaderboard(city: string): Promise<void> {
    const rows = await query<{ id: string; total_area_m2: number }>(`
      SELECT id, total_area_m2
      FROM users
      WHERE city = $1 AND is_active = true AND total_area_m2 > 0
      ORDER BY total_area_m2 DESC
      LIMIT 1000
    `, [city]);

    if (rows.length === 0) return;

    const key = LEADERBOARD_CITY_KEY(city);
    const pipeline = redis.pipeline();
    pipeline.del(key);

    const args: (string | number)[] = [];
    for (const row of rows) args.push(row.total_area_m2, row.id);
    pipeline.zadd(key, ...args);
    pipeline.expire(key, TTL.LEADERBOARD_CITY);

    await pipeline.exec();
  }

  /**
   * Hydrate leaderboard entries with user profile data
   * ZREVRANGE returns [userId, score, userId, score, ...]
   */
  private async hydrateEntries(
    results: string[],
    startRank: number
  ): Promise<LeaderboardEntry[]> {
    const userIds: string[] = [];
    const scores: number[] = [];

    for (let i = 0; i < results.length; i += 2) {
      userIds.push(results[i]);
      scores.push(parseFloat(results[i + 1]));
    }

    if (userIds.length === 0) return [];

    // Batch fetch user profiles
    const placeholders = userIds.map((_, i) => `$${i + 1}`).join(',');
    const users = await query<{
      id: string;
      username: string;
      display_name: string;
      avatar_url: string | null;
      city: string | null;
    }>(`
      SELECT id, username, display_name, avatar_url, city
      FROM users
      WHERE id IN (${placeholders})
    `, userIds);

    const userMap = new Map(users.map(u => [u.id, u]));

    return userIds.map((userId, index) => {
      const user = userMap.get(userId);
      return {
        rank: startRank + index + 1,
        userId,
        username: user?.username ?? 'Unknown',
        displayName: user?.display_name ?? 'Unknown',
        avatarUrl: user?.avatar_url ?? null,
        totalAreaM2: scores[index],
        city: user?.city ?? null,
      };
    });
  }
}

export const leaderboardService = new LeaderboardService();
