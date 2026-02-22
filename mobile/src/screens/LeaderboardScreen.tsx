import React, { useEffect, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  FlatList,
  TouchableOpacity,
  Image,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useSelector, useDispatch } from 'react-redux';
import type { RootState, AppDispatch } from '../store';
import {
  setGlobalLeaderboard,
  setCityLeaderboard,
  setMyRank,
  setActiveTab,
  setLoading,
  type LeaderboardEntry,
} from '../store/slices/leaderboard.slice';
import { leaderboardAPI } from '../services/api.service';
import { formatArea } from '../utils/geo.utils';

export default function LeaderboardScreen(): JSX.Element {
  const dispatch = useDispatch<AppDispatch>();
  const { user } = useSelector((s: RootState) => s.auth);
  const { globalEntries, cityEntries, myGlobalRank, activeTab, isLoading } = useSelector(
    (s: RootState) => s.leaderboard
  );

  const loadData = useCallback(async () => {
    dispatch(setLoading(true));
    try {
      const [globalRes, rankRes] = await Promise.all([
        leaderboardAPI.global(1),
        leaderboardAPI.myRank(),
      ]);
      dispatch(setGlobalLeaderboard(globalRes.data));
      dispatch(setMyRank(rankRes.data));

      if (user?.city) {
        const cityRes = await leaderboardAPI.city(user.city, 1);
        dispatch(setCityLeaderboard(cityRes.data.entries));
      }
    } catch (err) {
      console.error('Leaderboard load failed:', err);
    } finally {
      dispatch(setLoading(false));
    }
  }, [dispatch, user?.city]);

  useEffect(() => { loadData(); }, [loadData]);

  const entries = activeTab === 'global' ? globalEntries : cityEntries;

  const renderEntry = ({ item }: { item: LeaderboardEntry }) => {
    const isMe = item.userId === user?.id;

    return (
      <View style={[styles.entry, isMe && styles.myEntry]}>
        <Text style={[styles.rank, item.rank <= 3 && styles.topRank]}>
          {item.rank === 1 ? '🥇' : item.rank === 2 ? '🥈' : item.rank === 3 ? '🥉' : `#${item.rank}`}
        </Text>

        {item.avatarUrl ? (
          <Image source={{ uri: item.avatarUrl }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback]}>
            <Text style={styles.avatarText}>{item.displayName[0].toUpperCase()}</Text>
          </View>
        )}

        <View style={styles.info}>
          <Text style={[styles.name, isMe && styles.myName]} numberOfLines={1}>
            {item.displayName}
            {isMe && ' (You)'}
          </Text>
          <Text style={styles.username}>@{item.username}</Text>
        </View>

        <Text style={styles.area}>{formatArea(item.totalAreaM2)}</Text>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* My rank banner */}
      {myGlobalRank && (
        <View style={styles.myRankBanner}>
          <Text style={styles.myRankText}>
            Your rank: <Text style={styles.myRankNumber}>#{myGlobalRank}</Text> globally
          </Text>
          <Text style={styles.myAreaText}>{formatArea(user?.totalAreaM2 ?? 0)} owned</Text>
        </View>
      )}

      {/* Tab selector */}
      <View style={styles.tabs}>
        {(['global', 'city'] as const).map(tab => (
          <TouchableOpacity
            key={tab}
            style={[styles.tab, activeTab === tab && styles.activeTab]}
            onPress={() => dispatch(setActiveTab(tab))}
          >
            <Text style={[styles.tabText, activeTab === tab && styles.activeTabText]}>
              {tab === 'global' ? 'Global' : user?.city ?? 'City'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {isLoading ? (
        <ActivityIndicator style={styles.loader} color="#0066FF" size="large" />
      ) : (
        <FlatList
          data={entries}
          keyExtractor={item => item.userId}
          renderItem={renderEntry}
          refreshControl={<RefreshControl refreshing={false} onRefresh={loadData} tintColor="#0066FF" />}
          ListEmptyComponent={
            <Text style={styles.empty}>No data yet. Go walk!</Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },
  myRankBanner: {
    backgroundColor: '#0066FF',
    padding: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  myRankText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  myRankNumber: { fontSize: 18, fontWeight: '800' },
  myAreaText: { color: 'rgba(255,255,255,0.85)', fontSize: 14, fontWeight: '600' },
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#1C1C1E',
  },
  tab: { flex: 1, paddingVertical: 14, alignItems: 'center' },
  activeTab: { borderBottomWidth: 2, borderBottomColor: '#0066FF' },
  tabText: { color: '#8E8E93', fontSize: 15, fontWeight: '600' },
  activeTabText: { color: '#0066FF' },
  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1C1C1E',
  },
  myEntry: { backgroundColor: 'rgba(0, 102, 255, 0.08)' },
  rank: { width: 40, color: '#8E8E93', fontSize: 14, fontWeight: '600' },
  topRank: { fontSize: 22 },
  avatar: { width: 40, height: 40, borderRadius: 20, marginRight: 12 },
  avatarFallback: {
    backgroundColor: '#2C2C2E',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  info: { flex: 1 },
  name: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  myName: { color: '#0066FF' },
  username: { color: '#8E8E93', fontSize: 12 },
  area: { color: '#30D158', fontSize: 14, fontWeight: '700' },
  loader: { marginTop: 80 },
  empty: { color: '#8E8E93', textAlign: 'center', marginTop: 80, fontSize: 16 },
});
