import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  PORT: z.string().default('3000').transform(Number),

  // Database
  DATABASE_URL: z.string(),
  DATABASE_POOL_MIN: z.string().default('2').transform(Number),
  DATABASE_POOL_MAX: z.string().default('20').transform(Number),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Auth
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('7d'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  // OAuth
  GOOGLE_CLIENT_ID: z.string().optional(),
  APPLE_CLIENT_ID: z.string().optional(),
  APPLE_TEAM_ID: z.string().optional(),
  APPLE_KEY_ID: z.string().optional(),
  APPLE_PRIVATE_KEY: z.string().optional(),

  // Anti-cheat
  MAX_SPEED_KMH: z.string().default('50').transform(Number),
  MAX_VIOLATIONS_PER_SESSION: z.string().default('3').transform(Number),

  // GPS batching
  GPS_BATCH_INTERVAL_MS: z.string().default('3000').transform(Number),
  GPS_MIN_DISTANCE_METERS: z.string().default('10').transform(Number),
  GPS_MAX_BATCH_SIZE: z.string().default('50').transform(Number),

  // Territory
  MIN_POLYGON_AREA_M2: z.string().default('100').transform(Number),
  MAX_SESSION_AREA_M2: z.string().default('10000000').transform(Number), // 10 km² per session

  // CORS
  CORS_ORIGINS: z.string().default('http://localhost:8081'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
