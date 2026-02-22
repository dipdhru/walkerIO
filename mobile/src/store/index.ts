import { configureStore } from '@reduxjs/toolkit';
import authReducer from './slices/auth.slice';
import territoryReducer from './slices/territory.slice';
import sessionReducer from './slices/session.slice';
import leaderboardReducer from './slices/leaderboard.slice';

export const store = configureStore({
  reducer: {
    auth: authReducer,
    territory: territoryReducer,
    session: sessionReducer,
    leaderboard: leaderboardReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        // Socket.IO instance is not serializable
        ignoredPaths: ['session.socketInstance'],
      },
    }),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
