/**
 * WebSocket Service (Socket.IO Client)
 *
 * Singleton that manages the persistent WebSocket connection.
 * Handles automatic reconnection, event routing, and auth.
 */

import { io, Socket } from 'socket.io-client';
import { store } from '../store';
import { triggerStealAnimation, updateTerritory } from '../store/slices/territory.slice';
import { setStatus, incrementViolations } from '../store/slices/session.slice';
import { updateUserArea } from '../store/slices/auth.slice';

const API_WS_URL = __DEV__
  ? 'http://localhost:3000'
  : 'https://api.walkerio.app';

class WebSocketService {
  private socket: Socket | null = null;
  private isConnecting = false;

  connect(accessToken: string): void {
    if (this.socket?.connected || this.isConnecting) return;

    this.isConnecting = true;
    this.socket = io(API_WS_URL, {
      auth: { token: accessToken },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      reconnectionAttempts: Infinity,
      timeout: 10000,
    });

    this.registerEventHandlers();
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
    this.isConnecting = false;
  }

  /**
   * Send a GPS batch to the server
   * Uses socket.emit with acknowledgment callback
   */
  sendGpsBatch(params: {
    sessionId: string;
    points: Array<{
      latitude: number;
      longitude: number;
      altitude?: number;
      accuracy?: number;
      speed?: number;
      timestamp: number;
    }>;
    isMockLocationEnabled?: boolean;
  }): Promise<{
    ok: boolean;
    accepted: number;
    rejected: number;
    sessionInvalidated: boolean;
  }> {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      this.socket.timeout(5000).emit('location:batch', params, (err: Error, ack: unknown) => {
        if (err) reject(err);
        else resolve(ack as ReturnType<typeof this.sendGpsBatch> extends Promise<infer T> ? T : never);
      });
    });
  }

  /**
   * Start a game session
   */
  startSession(): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      this.socket.timeout(5000).emit('session:start', {}, (err: Error, ack: unknown) => {
        if (err) reject(err);
        else resolve(ack as { ok: boolean; sessionId?: string });
      });
    });
  }

  /**
   * End session and commit territory
   */
  endSession(params: {
    sessionId: string;
    city?: string;
    country?: string;
  }): Promise<{
    ok: boolean;
    areaM2?: number;
    distanceM?: number;
    events?: unknown[];
    error?: string;
  }> {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      // Generous timeout — polygon commit involves DB writes
      this.socket.timeout(15000).emit('session:end', params, (err: Error, ack: unknown) => {
        if (err) reject(err);
        else resolve(ack as ReturnType<typeof this.endSession> extends Promise<infer T> ? T : never);
      });
    });
  }

  cancelSession(sessionId: string): void {
    this.socket?.emit('session:cancel', { sessionId });
  }

  /**
   * Join a geographic area room to receive territory updates
   */
  joinGeographicRoom(geohash: string): void {
    this.socket?.emit('location:join_area', { geohash });
  }

  leaveGeographicRoom(geohash: string): void {
    this.socket?.emit('location:leave_area', { geohash });
  }

  get isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  private registerEventHandlers(): void {
    if (!this.socket) return;

    this.socket.on('connect', () => {
      console.log('[WS] Connected:', this.socket?.id);
      this.isConnecting = false;
    });

    this.socket.on('disconnect', (reason) => {
      console.log('[WS] Disconnected:', reason);
    });

    this.socket.on('connect_error', (err) => {
      console.error('[WS] Connection error:', err.message);
      this.isConnecting = false;
    });

    // Territory stolen FROM current user
    this.socket.on('territory:stolen_from', (data: {
      byUserId: string;
      areaLostM2: number;
    }) => {
      store.dispatch(triggerStealAnimation({
        type: 'lose',
        attackerUserId: data.byUserId,
        defenderUserId: store.getState().auth.user?.id ?? '',
        intersectionAreaM2: data.areaLostM2,
        timestamp: Date.now(),
      }));
    });

    // Session invalidated by anti-cheat
    this.socket.on('session:invalidated', () => {
      store.dispatch(setStatus('invalidated'));
      store.dispatch(incrementViolations());
    });

    // Nearby territory update (another player committed a polygon)
    this.socket.on('territory:nearby_update', (data: {
      userId: string;
      username: string;
      geometry: object;
      areaM2: number;
    }) => {
      store.dispatch(updateTerritory({
        userId: data.userId,
        username: data.username,
        geometry: data.geometry,
        areaM2: data.areaM2,
        isOwn: false,
      }));
    });
  }
}

export const wsService = new WebSocketService();
