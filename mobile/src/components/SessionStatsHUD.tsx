/**
 * SessionStatsHUD — heads-up display shown during active session
 * Shows live distance, session duration, and point count
 */

import React, { useEffect, useState } from 'react';
import { StyleSheet, View, Text } from 'react-native';
import { useSelector } from 'react-redux';
import type { RootState } from '../store';
import { formatArea } from '../utils/geo.utils';

export default function SessionStatsHUD(): JSX.Element {
  const { currentPoints, totalDistanceM, startedAt } = useSelector((s: RootState) => s.session);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      if (startedAt) setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;

  return (
    <View style={styles.container}>
      <Stat label="TIME" value={`${minutes}:${String(seconds).padStart(2, '0')}`} />
      <Stat label="DISTANCE" value={totalDistanceM >= 1000
        ? `${(totalDistanceM / 1000).toFixed(2)} km`
        : `${Math.round(totalDistanceM)} m`}
      />
      <Stat label="POINTS" value={String(currentPoints.length)} />
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <View style={styles.stat}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 60,
    left: 16,
    right: 16,
    flexDirection: 'row',
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderRadius: 16,
    padding: 12,
    justifyContent: 'space-around',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  stat: {
    alignItems: 'center',
  },
  label: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1,
    marginBottom: 2,
  },
  value: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
});
