import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { MMKV } from 'react-native-mmkv';

const storage = new MMKV({ id: 'auth' });

export interface User {
  id: string;
  email: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  totalAreaM2: number;
  city: string | null;
}

interface AuthState {
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  isLoading: boolean;
  error: string | null;
}

const initialState: AuthState = {
  user: null,
  accessToken: storage.getString('access_token') ?? null,
  refreshToken: storage.getString('refresh_token') ?? null,
  isLoading: false,
  error: null,
};

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    setTokens(state, action: PayloadAction<{ accessToken: string; refreshToken: string }>) {
      state.accessToken = action.payload.accessToken;
      state.refreshToken = action.payload.refreshToken;
      storage.set('access_token', action.payload.accessToken);
      storage.set('refresh_token', action.payload.refreshToken);
    },
    setUser(state, action: PayloadAction<User>) {
      state.user = action.payload;
    },
    logout(state) {
      state.user = null;
      state.accessToken = null;
      state.refreshToken = null;
      storage.delete('access_token');
      storage.delete('refresh_token');
    },
    updateUserArea(state, action: PayloadAction<number>) {
      if (state.user) {
        state.user.totalAreaM2 = action.payload;
      }
    },
    setError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
  },
});

export const { setTokens, setUser, logout, updateUserArea, setError } = authSlice.actions;
export default authSlice.reducer;
