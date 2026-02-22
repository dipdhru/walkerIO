/**
 * MapScreen — Main game screen
 *
 * Features:
 * - Mapbox map with territory layers
 * - Own territory = Blue (#0066FF)
 * - Others' territory = Red (#FF3B30)
 * - Live GPS path preview while session active
 * - Animated steal/lose effects
 * - Start/Stop session button
 * - Mini leaderboard overlay
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  StyleSheet,
  View,
  TouchableOpacity,
  Text,
  Alert,
  ActivityIndicator,
} from 'react-native';
import MapboxGL from '@rnmapbox/maps';
import { useSelector, useDispatch } from 'react-redux';
import type { RootState, AppDispatch } from '../store';
import { startSession, setStatus, resetSession } from '../store/slices/session.slice';
import { setViewportTerritories, clearStealAnimation } from '../store/slices/territory.slice';
import { gpsService } from '../services/gps.service';
import { wsService } from '../services/websocket.service';
import { territoryAPI } from '../services/api.service';
import { toGeohash } from '../utils/geo.utils';
import StealAnimation from '../components/StealAnimation';
import SessionStatsHUD from '../components/SessionStatsHUD';

MapboxGL.setAccessToken('YOUR_MAPBOX_PUBLIC_TOKEN');

export default function MapScreen(): JSX.Element {
  const dispatch = useDispatch<AppDispatch>();
  const cameraRef = useRef<MapboxGL.Camera>(null);
  const mapRef = useRef<MapboxGL.MapView>(null);

  const { user } = useSelector((s: RootState) => s.auth);
  const { status: sessionStatus, currentPoints, sessionId } = useSelector((s: RootState) => s.session);
  const { territories, myTerritory, pendingStealAnimation } = useSelector((s: RootState) => s.territory);

  const [userLocation, setUserLocation] = useState<[number, number] | null>(null);
  const [currentGeohash, setCurrentGeohash] = useState<string>('');
  const [isMapReady, setIsMapReady] = useState(false);
  const [isEndingSession, setIsEndingSession] = useState(false);

  const isSessionActive = sessionStatus === 'active';

  // Load territory for current viewport
  const loadViewportTerritories = useCallback(async (bounds: {
    ne: [number, number];
    sw: [number, number];
  }) => {
    try {
      const { data } = await territoryAPI.getViewport({
        minLng: bounds.sw[0],
        minLat: bounds.sw[1],
        maxLng: bounds.ne[0],
        maxLat: bounds.ne[1],
        zoom: 14,
      });
      dispatch(setViewportTerritories(
        data.territories.map((t: {
          userId: string;
          username: string;
          geometry: object;
          areaM2: number;
        }) => ({
          ...t,
          isOwn: t.userId === user?.id,
        }))
      ));
    } catch (err) {
      console.warn('Failed to load territories:', err);
    }
  }, [dispatch, user?.id]);

  // Handle user position updates
  const handleUserLocationUpdate = useCallback((location: MapboxGL.Location) => {
    const { longitude, latitude } = location.coords;
    setUserLocation([longitude, latitude]);

    // Switch geographic WebSocket room when cell changes
    const newGeohash = toGeohash(latitude, longitude, 3);
    if (newGeohash !== currentGeohash) {
      if (currentGeohash) wsService.leaveGeographicRoom(currentGeohash);
      wsService.joinGeographicRoom(newGeohash);
      setCurrentGeohash(newGeohash);
    }
  }, [currentGeohash]);

  const handleStartSession = async (): Promise<void> => {
    try {
      const result = await wsService.startSession();
      if (!result.ok || !result.sessionId) {
        Alert.alert('Error', result.error ?? 'Failed to start session');
        return;
      }
      dispatch(startSession(result.sessionId));
      await gpsService.startTracking(result.sessionId);
    } catch (err) {
      Alert.alert('Error', 'Could not start session. Check your connection.');
    }
  };

  const handleEndSession = async (): Promise<void> => {
    if (!sessionId) return;
    setIsEndingSession(true);

    try {
      await gpsService.stopTracking();
      dispatch(setStatus('ending'));

      const result = await wsService.endSession({
        sessionId,
        city: user?.city ?? undefined,
      });

      dispatch(resetSession());

      if (result.ok && result.areaM2) {
        Alert.alert(
          'Territory Claimed!',
          `You captured ${(result.areaM2 / 1000).toFixed(1)} km²\n` +
          `Distance: ${((result.distanceM ?? 0) / 1000).toFixed(2)} km`,
        );
      }
    } catch (err) {
      Alert.alert('Error', 'Failed to end session. Your territory may not have been saved.');
      dispatch(resetSession());
    } finally {
      setIsEndingSession(false);
    }
  };

  // Build GeoJSON for territory rendering
  const territoriesGeoJSON = {
    type: 'FeatureCollection' as const,
    features: Object.values(territories).map(t => ({
      type: 'Feature' as const,
      properties: { userId: t.userId, username: t.username, isOwn: t.isOwn },
      geometry: t.geometry,
    })),
  };

  // Build live GPS path as GeoJSON LineString for preview
  const livePathGeoJSON = currentPoints.length >= 2 ? {
    type: 'Feature' as const,
    properties: {},
    geometry: {
      type: 'LineString' as const,
      coordinates: currentPoints.map(p => [p.longitude, p.latitude]),
    },
  } : null;

  return (
    <View style={styles.container}>
      <MapboxGL.MapView
        ref={mapRef}
        style={styles.map}
        styleURL={MapboxGL.StyleURL.Dark}
        onDidFinishLoadingMap={() => setIsMapReady(true)}
        onRegionDidChange={async (region) => {
          if (!isMapReady) return;
          const bounds = await mapRef.current?.getVisibleBounds();
          if (bounds) {
            await loadViewportTerritories({
              ne: bounds[0] as [number, number],
              sw: bounds[1] as [number, number],
            });
          }
        }}
      >
        <MapboxGL.Camera
          ref={cameraRef}
          zoomLevel={14}
          followUserLocation={isSessionActive}
          followUserMode="compass"
        />

        {/* User location dot */}
        <MapboxGL.UserLocation
          visible
          onUpdate={handleUserLocationUpdate}
          renderMode="native"
          showsUserHeadingIndicator
        />

        {/* Territory fill layer — others = red, own = blue */}
        <MapboxGL.ShapeSource id="territories" shape={territoriesGeoJSON}>
          <MapboxGL.FillLayer
            id="territory-fill"
            style={{
              fillColor: [
                'case',
                ['get', 'isOwn'],
                'rgba(0, 102, 255, 0.35)',   // own: blue
                'rgba(255, 59, 48, 0.35)',    // others: red
              ],
              fillAntialias: true,
            }}
          />
          <MapboxGL.LineLayer
            id="territory-border"
            style={{
              lineColor: [
                'case',
                ['get', 'isOwn'],
                '#0066FF',
                '#FF3B30',
              ],
              lineWidth: 2,
              lineOpacity: 0.8,
            }}
          />
        </MapboxGL.ShapeSource>

        {/* Live GPS path preview */}
        {livePathGeoJSON && (
          <MapboxGL.ShapeSource id="live-path" shape={livePathGeoJSON}>
            <MapboxGL.LineLayer
              id="live-path-line"
              style={{
                lineColor: '#FFD700',
                lineWidth: 3,
                lineDasharray: [2, 1],
                lineOpacity: 0.9,
              }}
            />
          </MapboxGL.ShapeSource>
        )}
      </MapboxGL.MapView>

      {/* Steal animation overlay */}
      {pendingStealAnimation && (
        <StealAnimation
          event={pendingStealAnimation}
          onComplete={() => dispatch(clearStealAnimation())}
        />
      )}

      {/* Session HUD */}
      {isSessionActive && <SessionStatsHUD />}

      {/* Start / Stop button */}
      <View style={styles.buttonContainer}>
        {!isSessionActive ? (
          <TouchableOpacity
            style={[styles.actionButton, styles.startButton]}
            onPress={handleStartSession}
          >
            <Text style={styles.buttonText}>START WALK</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.actionButton, styles.stopButton]}
            onPress={handleEndSession}
            disabled={isEndingSession}
          >
            {isEndingSession ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>CLAIM TERRITORY</Text>
            )}
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  map: {
    flex: 1,
  },
  buttonContainer: {
    position: 'absolute',
    bottom: 48,
    left: 24,
    right: 24,
    alignItems: 'center',
  },
  actionButton: {
    width: '80%',
    paddingVertical: 18,
    borderRadius: 50,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 8,
  },
  startButton: {
    backgroundColor: '#0066FF',
  },
  stopButton: {
    backgroundColor: '#FF3B30',
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
});
