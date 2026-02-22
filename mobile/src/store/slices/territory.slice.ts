import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface TerritoryFeature {
  userId: string;
  username: string;
  geometry: object;  // GeoJSON geometry
  areaM2: number;
  isOwn: boolean;
}

export interface StealEvent {
  type: 'steal' | 'lose' | 'split';
  attackerUserId: string;
  defenderUserId: string;
  intersectionAreaM2: number;
  timestamp: number;
}

interface TerritoryState {
  territories: Record<string, TerritoryFeature>; // userId → territory
  myTerritory: TerritoryFeature | null;
  pendingStealAnimation: StealEvent | null;
  isLoading: boolean;
}

const initialState: TerritoryState = {
  territories: {},
  myTerritory: null,
  pendingStealAnimation: null,
  isLoading: false,
};

const territorySlice = createSlice({
  name: 'territory',
  initialState,
  reducers: {
    setViewportTerritories(state, action: PayloadAction<TerritoryFeature[]>) {
      action.payload.forEach(t => {
        state.territories[t.userId] = t;
      });
    },
    updateTerritory(state, action: PayloadAction<TerritoryFeature>) {
      const t = action.payload;
      state.territories[t.userId] = t;
      if (t.isOwn) state.myTerritory = t;
    },
    removeTerritory(state, action: PayloadAction<string>) {
      delete state.territories[action.payload];
    },
    setMyTerritory(state, action: PayloadAction<TerritoryFeature | null>) {
      state.myTerritory = action.payload;
    },
    triggerStealAnimation(state, action: PayloadAction<StealEvent>) {
      state.pendingStealAnimation = action.payload;
    },
    clearStealAnimation(state) {
      state.pendingStealAnimation = null;
    },
    setLoading(state, action: PayloadAction<boolean>) {
      state.isLoading = action.payload;
    },
  },
});

export const {
  setViewportTerritories,
  updateTerritory,
  removeTerritory,
  setMyTerritory,
  triggerStealAnimation,
  clearStealAnimation,
  setLoading,
} = territorySlice.actions;
export default territorySlice.reducer;
