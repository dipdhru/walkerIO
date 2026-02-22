import rateLimit from 'express-rate-limit';
import { redis } from '../config/redis';
import { Request, Response } from 'express';

// Custom Redis store for distributed rate limiting across instances
class RedisStore {
  prefix: string;
  sendCommand: (...args: string[]) => Promise<unknown>;

  constructor(prefix: string) {
    this.prefix = prefix;
    this.sendCommand = (...args: string[]) => redis.call(args[0], ...args.slice(1)) as Promise<unknown>;
  }

  async increment(key: string): Promise<{ totalHits: number; resetTime: Date }> {
    const redisKey = `${this.prefix}:${key}`;
    const totalHits = await redis.incr(redisKey);
    if (totalHits === 1) {
      await redis.expire(redisKey, 900); // 15 min window
    }
    const ttl = await redis.ttl(redisKey);
    return { totalHits, resetTime: new Date(Date.now() + ttl * 1000) };
  }

  async decrement(key: string): Promise<void> {
    await redis.decr(`${this.prefix}:${key}`);
  }

  async resetKey(key: string): Promise<void> {
    await redis.del(`${this.prefix}:${key}`);
  }
}

export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many auth attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) =>
    req.ip ?? req.headers['x-forwarded-for']?.toString() ?? 'unknown',
});

export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Rate limit exceeded. Max 120 requests/minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const gpsRateLimit = rateLimit({
  windowMs: 1000,
  max: 5, // 5 GPS batches/second per user
  message: { error: 'GPS update rate exceeded.' },
  keyGenerator: (req: Request) => (req.user?.sub ?? req.ip) as string,
});
