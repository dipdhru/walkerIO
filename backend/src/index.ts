import { createServer } from 'http';
import { createApp } from './app';
import { setupWebSocket } from './websocket';
import { checkDatabaseConnection } from './config/database';
import { checkRedisConnection } from './config/redis';
import { env } from './config/env';
import { logger } from './utils/logger';

async function bootstrap(): Promise<void> {
  // Verify external dependencies before accepting traffic
  await checkDatabaseConnection();
  await checkRedisConnection();

  const app = createApp();
  const httpServer = createServer(app);

  // Attach Socket.IO to the same HTTP server
  setupWebSocket(httpServer);

  httpServer.listen(env.PORT, () => {
    logger.info(`Walker.IO backend running`, {
      port: env.PORT,
      env: env.NODE_ENV,
    });
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down gracefully`);
    httpServer.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('Force shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason });
  });
}

bootstrap().catch((err) => {
  logger.error('Failed to start server', { error: err.message });
  process.exit(1);
});
