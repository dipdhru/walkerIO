import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  totalAreaM2: number;
  city: string | null;
}

interface LeaderboardState {
  globalEntries: LeaderboardEntry[];
  cityEntries: LeaderboardEntry[];
  myGlobalRank: number | null;
  myCityRank: number | null;
  totalGlobal: number;
  isLoading: boolean;
  activeTab: 'global' | 'city';
}

const initialState: LeaderboardState = {
  globalEntries: [],
  cityEntries: [],
  myGlobalRank: null,
  myCityRank: null,
  totalGlobal: 0,
  isLoading: false,
  activeTab: 'global',
};

const leaderboardSlice = createSlice({
  name: 'leaderboard',
  initialState,
  reducers: {
    setGlobalLeaderboard(state, action: PayloadAction<{ entries: LeaderboardEntry[]; total: number }>) {
      state.globalEntries = action.payload.entries;
      state.totalGlobal = action.payload.total;
    },
    setCityLeaderboard(state, action: PayloadAction<LeaderboardEntry[]>) {
      state.cityEntries = action.payload;
    },
    setMyRank(state, action: PayloadAction<{ globalRank: number | null; cityRank: number | null }>) {
      state.myGlobalRank = action.payload.globalRank;
      state.myCityRank = action.payload.cityRank;
    },
    setActiveTab(state, action: PayloadAction<'global' | 'city'>) {
      state.activeTab = action.payload;
    },
    setLoading(state, action: PayloadAction<boolean>) {
      state.isLoading = action.payload;
    },
  },
});

export const { setGlobalLeaderboard, setCityLeaderboard, setMyRank, setActiveTab, setLoading } =
  leaderboardSlice.actions;
export default leaderboardSlice.reducer;
