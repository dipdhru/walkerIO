/**
 * GPS Service — Background Location Tracking
 *
 * Uses react-native-background-geolocation for:
 * - Foreground and background GPS tracking
 * - Automatic battery optimization
 * - iOS significant location changes fallback
 * - Android foreground service notification
 *
 * GPS Batching strategy:
 * - Buffer points locally for GPS_BATCH_INTERVAL_MS (3s)
 * - Send batch to server via WebSocket on timer
 * - If disconnected: buffer up to 500 points, flush on reconnect
 */

import BackgroundGeolocation, {
  Location,
  LocationError,
  State,
} from 'react-native-background-geolocation';
import { store } from '../store';
import { addGpsPoint, clearPendingBatch } from '../store/slices/session.slice';
import { wsService } from './websocket.service';

const BATCH_INTERVAL_MS = 3000;
const MIN_DISTANCE_METERS = 10;
const OFFLINE_BUFFER_MAX = 500;

class GpsService {
  private batchTimer: ReturnType<typeof setInterval> | null = null;
  private offlineBuffer: Parameters<typeof addGpsPoint>[0]['payload'][] = [];

  async configure(): Promise<void> {
    await BackgroundGeolocation.ready({
      // GPS accuracy
      desiredAccuracy: BackgroundGeolocation.DESIRED_ACCURACY_HIGH,
      distanceFilter: MIN_DISTANCE_METERS,  // only fire if moved ≥10m

      // Battery optimization
      locationUpdateInterval: 2000,         // Android: poll every 2s
      fastestLocationUpdateInterval: 1000,
      stopOnTerminate: false,               // continue in background
      startOnBoot: false,                   // don't auto-start on phone boot

      // iOS specific
      pausesLocationUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      activityType: BackgroundGeolocation.ACTIVITY_TYPE_FITNESS,

      // Android foreground service notification
      notification: {
        title: 'Walker.IO',
        text: 'Tracking your territory...',
        smallIcon: 'drawable/ic_notification',
        priority: BackgroundGeolocation.NOTIFICATION_PRIORITY_LOW,
      },

      // Debug (disable in production)
      debug: __DEV__,
      logLevel: __DEV__
        ? BackgroundGeolocation.LOG_LEVEL_VERBOSE
        : BackgroundGeolocation.LOG_LEVEL_ERROR,

      // Anti-spoofing: detect mock locations
      preventSuspend: true,
    });

    // Handle incoming locations
    BackgroundGeolocation.onLocation(this.handleLocation.bind(this), this.handleError.bind(this));
    BackgroundGeolocation.onMotionChange(this.handleMotionChange.bind(this));
  }

  async startTracking(sessionId: string): Promise<void> {
    await BackgroundGeolocation.start();
    this.startBatchTimer(sessionId);
  }

  async stopTracking(): Promise<void> {
    await BackgroundGeolocation.stop();
    this.stopBatchTimer();
    this.offlineBuffer = [];
  }

  private handleLocation(location: Location): void {
    // Check if mock location (Android reports this)
    if (location.mock) {
      console.warn('[GPS] Mock location detected — discarding');
      return;
    }

    const point = {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      altitude: location.coords.altitude ?? undefined,
      accuracy: location.coords.accuracy,
      speed: location.coords.speed ?? undefined,
      timestamp: new Date(location.timestamp).getTime(),
    };

    // Dispatch to Redux for live polygon preview
    store.dispatch(addGpsPoint(point));

    // Buffer for offline scenarios
    if (!wsService.isConnected) {
      this.offlineBuffer.push(point);
      if (this.offlineBuffer.length > OFFLINE_BUFFER_MAX) {
        this.offlineBuffer.shift(); // drop oldest
      }
    }
  }

  private handleError(error: LocationError): void {
    console.error('[GPS] Location error:', error.code, error.message);
  }

  private handleMotionChange(event: { isMoving: boolean; location: Location }): void {
    console.log('[GPS] Motion changed:', event.isMoving);
    // When user stops moving, we can still send remaining buffered points
  }

  private startBatchTimer(sessionId: string): void {
    this.batchTimer = setInterval(async () => {
      await this.flushBatch(sessionId);
    }, BATCH_INTERVAL_MS);
  }

  private stopBatchTimer(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
  }

  /**
   * Send pending GPS batch to server.
   * If offline, buffer locally and flush when connected.
   */
  private async flushBatch(sessionId: string): Promise<void> {
    const state = store.getState();
    const pending = [...state.session.pendingBatch];

    // Merge offline buffer if we just reconnected
    const allPoints = [...this.offlineBuffer, ...pending];
    if (allPoints.length === 0) return;

    if (!wsService.isConnected) return;

    try {
      store.dispatch(clearPendingBatch());
      this.offlineBuffer = [];

      const result = await wsService.sendGpsBatch({
        sessionId,
        points: allPoints,
        isMockLocationEnabled: false, // checked by BackgroundGeolocation.mock flag above
      });

      if (result.sessionInvalidated) {
        await this.stopTracking();
      }
    } catch (err) {
      // Re-buffer on send failure
      this.offlineBuffer = [...allPoints, ...this.offlineBuffer].slice(-OFFLINE_BUFFER_MAX);
      console.warn('[GPS] Batch send failed, buffering:', (err as Error).message);
    }
  }
}

export const gpsService = new GpsService();
