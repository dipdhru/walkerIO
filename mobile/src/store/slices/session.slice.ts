import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface GpsPoint {
  latitude: number;
  longitude: number;
  altitude?: number;
  accuracy?: number;
  speed?: number;
  timestamp: number;
}

type SessionStatus = 'idle' | 'active' | 'ending' | 'invalidated';

interface SessionState {
  sessionId: string | null;
  status: SessionStatus;
  currentPoints: GpsPoint[];
  pendingBatch: GpsPoint[];
  totalDistanceM: number;
  sessionAreaM2: number;
  startedAt: number | null;
  violations: number;
  lastKnownPosition: GpsPoint | null;
}

const initialState: SessionState = {
  sessionId: null,
  status: 'idle',
  currentPoints: [],
  pendingBatch: [],
  totalDistanceM: 0,
  sessionAreaM2: 0,
  startedAt: null,
  violations: 0,
  lastKnownPosition: null,
};

const sessionSlice = createSlice({
  name: 'session',
  initialState,
  reducers: {
    startSession(state, action: PayloadAction<string>) {
      state.sessionId = action.payload;
      state.status = 'active';
      state.currentPoints = [];
      state.pendingBatch = [];
      state.totalDistanceM = 0;
      state.sessionAreaM2 = 0;
      state.startedAt = Date.now();
      state.violations = 0;
    },
    addGpsPoint(state, action: PayloadAction<GpsPoint>) {
      state.currentPoints.push(action.payload);
      state.pendingBatch.push(action.payload);
      state.lastKnownPosition = action.payload;
    },
    clearPendingBatch(state) {
      state.pendingBatch = [];
    },
    updateDistance(state, action: PayloadAction<number>) {
      state.totalDistanceM = action.payload;
    },
    setStatus(state, action: PayloadAction<SessionStatus>) {
      state.status = action.payload;
    },
    incrementViolations(state) {
      state.violations++;
    },
    resetSession(state) {
      Object.assign(state, initialState);
    },
  },
});

export const {
  startSession,
  addGpsPoint,
  clearPendingBatch,
  updateDistance,
  setStatus,
  incrementViolations,
  resetSession,
} = sessionSlice.actions;
export default sessionSlice.reducer;
