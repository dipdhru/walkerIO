import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { env } from './config/env';
import { apiRateLimit } from './middleware/rateLimit.middleware';
import { errorHandler, notFound } from './middleware/error.middleware';

// Routes
import { authRouter } from './api/routes/auth.routes';
import { territoryRouter } from './api/routes/territory.routes';
import { leaderboardRouter } from './api/routes/leaderboard.routes';
import { sessionRouter } from './api/routes/session.routes';

export function createApp(): express.Application {
  const app = express();

  // Security headers
  app.use(helmet({
    contentSecurityPolicy: env.NODE_ENV === 'production',
  }));

  // CORS — whitelist app origins
  app.use(cors({
    origin: env.CORS_ORIGINS.split(','),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }));

  // Body parsing
  app.use(express.json({ limit: '512kb' }));
  app.use(express.urlencoded({ extended: true }));

  // Compression
  app.use(compression());

  // Trust proxy (for correct IP behind ALB)
  app.set('trust proxy', 1);

  // Global rate limit
  app.use('/api', apiRateLimit);

  // Health check (no auth, no rate limit — used by ALB/k8s probes)
  app.get('/health', (_, res) => {
    res.json({ status: 'ok', version: process.env.npm_package_version });
  });

  // API routes
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/territories', territoryRouter);
  app.use('/api/v1/leaderboard', leaderboardRouter);
  app.use('/api/v1/sessions', sessionRouter);

  // 404 + error handling (must be last)
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
