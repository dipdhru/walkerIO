import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { redis, CacheKey } from '../config/redis';

export interface JwtPayload {
  sub: string;   // userId
  email: string;
  username: string;
  iat: number;
  exp: number;
}

declare global {
  namespace Express {
    interface Request {
      user: JwtPayload;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Verify WebSocket connection token — used in Socket.IO auth middleware
 */
export function verifySocketToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, env.JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * Blacklist a token (for logout) — stored in Redis until expiry
 */
export async function blacklistToken(token: string, expiresAt: number): Promise<void> {
  const ttl = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
  if (ttl > 0) {
    await redis.setex(`token:blacklist:${token}`, ttl, '1');
  }
}

export async function isTokenBlacklisted(token: string): Promise<boolean> {
  const result = await redis.get(`token:blacklist:${token}`);
  return result !== null;
}
