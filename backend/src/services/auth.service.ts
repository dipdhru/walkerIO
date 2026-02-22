import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../config/database';
import { redis, CacheKey, TTL } from '../config/redis';
import { env } from '../config/env';
import { AppError } from '../middleware/error.middleware';
import { logger } from '../utils/logger';

interface User {
  id: string;
  email: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  auth_provider: string;
  total_area_m2: number;
  city: string | null;
  country: string | null;
  created_at: Date;
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

const googleClient = new OAuth2Client(env.GOOGLE_CLIENT_ID);

function generateTokens(user: Pick<User, 'id' | 'email' | 'username'>): TokenPair {
  const payload = { sub: user.id, email: user.email, username: user.username };

  const accessToken = jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });

  const refreshToken = jwt.sign(
    { sub: user.id, type: 'refresh' },
    env.JWT_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRES_IN as jwt.SignOptions['expiresIn'] }
  );

  return { accessToken, refreshToken, expiresIn: 7 * 24 * 3600 };
}

export class AuthService {
  async registerEmail(params: {
    email: string;
    password: string;
    username: string;
    displayName: string;
  }): Promise<{ user: User; tokens: TokenPair }> {
    const passwordHash = await bcrypt.hash(params.password, 12);

    const [user] = await query<User>(`
      INSERT INTO users (email, username, display_name, password_hash, auth_provider)
      VALUES ($1, $2, $3, $4, 'email')
      RETURNING id, email, username, display_name, avatar_url, auth_provider,
                total_area_m2, city, country, created_at
    `, [params.email.toLowerCase(), params.username, params.displayName, passwordHash]);

    if (!user) throw new AppError(500, 'Failed to create user');

    logger.info('User registered', { userId: user.id, provider: 'email' });
    return { user, tokens: generateTokens(user) };
  }

  async loginEmail(email: string, password: string): Promise<{ user: User; tokens: TokenPair }> {
    const [user] = await query<User & { password_hash: string }>(`
      SELECT id, email, username, display_name, avatar_url, auth_provider,
             total_area_m2, city, country, created_at, password_hash
      FROM users
      WHERE email = $1 AND auth_provider = 'email' AND is_active = true
    `, [email.toLowerCase()]);

    if (!user) throw new AppError(401, 'Invalid credentials');

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) throw new AppError(401, 'Invalid credentials');

    return { user, tokens: generateTokens(user) };
  }

  async loginGoogle(idToken: string): Promise<{ user: User; tokens: TokenPair }> {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) {
      throw new AppError(401, 'Invalid Google token');
    }

    const { user } = await withTransaction(async (client) => {
      // Upsert user
      const result = await client.query(`
        INSERT INTO users (email, username, display_name, avatar_url, auth_provider, auth_provider_id)
        VALUES ($1, $2, $3, $4, 'google', $5)
        ON CONFLICT (auth_provider, auth_provider_id)
          DO UPDATE SET
            display_name = EXCLUDED.display_name,
            avatar_url = EXCLUDED.avatar_url,
            updated_at = NOW()
        RETURNING id, email, username, display_name, avatar_url, auth_provider,
                  total_area_m2, city, country, created_at
      `, [
        payload.email.toLowerCase(),
        payload.email.split('@')[0].replace(/[^a-z0-9_]/gi, '') + '_' + uuidv4().slice(0, 6),
        payload.name ?? payload.email,
        payload.picture ?? null,
        payload.sub,
      ]);

      return { user: result.rows[0] as User };
    });

    return { user, tokens: generateTokens(user) };
  }

  async refreshToken(refreshToken: string): Promise<TokenPair> {
    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(refreshToken, env.JWT_SECRET) as jwt.JwtPayload;
    } catch {
      throw new AppError(401, 'Invalid refresh token');
    }

    if (payload.type !== 'refresh') throw new AppError(401, 'Invalid token type');

    const [user] = await query<User>(`
      SELECT id, email, username FROM users WHERE id = $1 AND is_active = true
    `, [payload.sub]);

    if (!user) throw new AppError(401, 'User not found');

    return generateTokens(user);
  }

  async getUserProfile(userId: string): Promise<User> {
    const cacheKey = CacheKey.userProfile(userId);
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as User;

    const [user] = await query<User>(`
      SELECT id, email, username, display_name, avatar_url, auth_provider,
             total_area_m2, city, country, created_at
      FROM users
      WHERE id = $1 AND is_active = true
    `, [userId]);

    if (!user) throw new AppError(404, 'User not found');

    await redis.setex(cacheKey, TTL.USER_PROFILE, JSON.stringify(user));
    return user;
  }

  async updateProfile(userId: string, updates: { displayName?: string; username?: string; city?: string }): Promise<User> {
    const [user] = await query<User>(`
      UPDATE users
      SET
        display_name = COALESCE($2, display_name),
        username = COALESCE($3, username),
        city = COALESCE($4, city),
        updated_at = NOW()
      WHERE id = $1
      RETURNING id, email, username, display_name, avatar_url, auth_provider,
                total_area_m2, city, country, created_at
    `, [userId, updates.displayName, updates.username, updates.city]);

    if (!user) throw new AppError(404, 'User not found');

    // Invalidate cache
    await redis.del(CacheKey.userProfile(userId));
    return user;
  }
}

export const authService = new AuthService();
