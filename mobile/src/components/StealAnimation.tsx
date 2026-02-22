/**
 * StealAnimation — fullscreen animated overlay for territory steal/lose events
 *
 * Shows when another player steals your territory or you steal theirs.
 * Uses React Native Reanimated for smooth 60fps animation.
 */

import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSequence,
  withTiming,
  withDelay,
  runOnJS,
  Easing,
} from 'react-native-reanimated';
import type { StealEvent } from '../store/slices/territory.slice';
import { formatArea } from '../utils/geo.utils';

interface Props {
  event: StealEvent;
  onComplete: () => void;
}

export default function StealAnimation({ event, onComplete }: Props): JSX.Element {
  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.6);
  const translateY = useSharedValue(20);

  const isSteal = event.type === 'steal';
  const isLose = event.type === 'lose';

  useEffect(() => {
    // Animate in
    opacity.value = withSequence(
      withTiming(1, { duration: 300, easing: Easing.out(Easing.cubic) }),
      withDelay(2000, withTiming(0, { duration: 500 }, (finished) => {
        if (finished) runOnJS(onComplete)();
      }))
    );

    scale.value = withSequence(
      withTiming(1.1, { duration: 300, easing: Easing.out(Easing.back(1.5)) }),
      withTiming(1, { duration: 200 }),
      withDelay(2000, withTiming(0.8, { duration: 500 }))
    );

    translateY.value = withTiming(0, { duration: 300 });
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }, { translateY: translateY.value }],
  }));

  return (
    <View style={styles.overlay} pointerEvents="none">
      <Animated.View
        style={[
          styles.card,
          isSteal ? styles.stealCard : styles.loseCard,
          animatedStyle,
        ]}
      >
        <Text style={styles.emoji}>{isSteal ? '⚔️' : isLose ? '🛡️' : '🤝'}</Text>
        <Text style={styles.title}>
          {isSteal ? 'TERRITORY STOLEN!' : isLose ? 'TERRITORY LOST!' : 'TERRITORY SPLIT!'}
        </Text>
        <Text style={styles.area}>
          {formatArea(event.intersectionAreaM2)}
        </Text>
        <Text style={styles.detail}>
          {isSteal
            ? `You claimed ${formatArea(event.intersectionAreaM2)} from a rival`
            : isLose
            ? `A larger walker took ${formatArea(event.intersectionAreaM2)}`
            : `Area split 50/50 between equal walkers`}
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 999,
  },
  card: {
    width: 300,
    padding: 28,
    borderRadius: 20,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 16,
    elevation: 16,
  },
  stealCard: {
    backgroundColor: 'rgba(0, 102, 255, 0.92)',
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.3)',
  },
  loseCard: {
    backgroundColor: 'rgba(255, 59, 48, 0.92)',
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.3)',
  },
  emoji: {
    fontSize: 48,
    marginBottom: 8,
  },
  title: {
    fontSize: 20,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 1,
    marginBottom: 8,
  },
  area: {
    fontSize: 32,
    fontWeight: '700',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  detail: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.8)',
    textAlign: 'center',
  },
});
