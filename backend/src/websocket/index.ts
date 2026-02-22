import { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { redisPub, redisSub } from '../config/redis';
import { verifySocketToken, JwtPayload } from '../middleware/auth.middleware';
import { handleLocationUpdate } from './handlers/location.handler';
import { handleSessionEvents } from './handlers/session.handler';
import { logger } from '../utils/logger';
import { env } from '../config/env';

let ioInstance: SocketIOServer | null = null;

declare module 'socket.io' {
  interface Socket {
    user: JwtPayload;
  }
}

export function setupWebSocket(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: env.CORS_ORIGINS.split(','),
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 20000,
    pingInterval: 10000,
    // Compression for large territory payloads
    perMessageDeflate: {
      threshold: 1024, // compress messages > 1KB
    },
  });

  // Redis adapter — enables horizontal scaling across multiple Node.js instances
  // Each instance can emit to rooms that are joined on OTHER instances
  io.adapter(createAdapter(redisPub, redisSub));

  // Auth middleware — validate JWT before any connection completes
  io.use((socket, next) => {
    const token = socket.handshake.auth.token as string;
    if (!token) {
      next(new Error('Authentication required'));
      return;
    }

    const user = verifySocketToken(token);
    if (!user) {
      next(new Error('Invalid token'));
      return;
    }

    socket.user = user;
    next();
  });

  io.on('connection', (socket: Socket) => {
    const userId = socket.user.sub;
    logger.info('WebSocket connected', { userId, socketId: socket.id });

    // Join user's personal room (for direct notifications like "you were stolen from")
    socket.join(`user:${userId}`);

    // Register event handlers
    handleLocationUpdate(io, socket);
    handleSessionEvents(io, socket);

    socket.on('disconnect', (reason) => {
      logger.info('WebSocket disconnected', { userId, reason });
    });

    socket.on('error', (err) => {
      logger.error('WebSocket error', { userId, error: err.message });
    });
  });

  ioInstance = io;
  logger.info('WebSocket server initialized with Redis adapter');
  return io;
}

export function getIoInstance(): SocketIOServer | null {
  return ioInstance;
}
