import axios, { AxiosInstance, AxiosError } from 'axios';
import { store } from '../store';
import { setTokens, logout } from '../store/slices/auth.slice';

const BASE_URL = __DEV__
  ? 'http://localhost:3000/api/v1'
  : 'https://api.walkerio.app/api/v1';

function createApiClient(): AxiosInstance {
  const client = axios.create({
    baseURL: BASE_URL,
    timeout: 15000,
    headers: { 'Content-Type': 'application/json' },
  });

  // Attach auth token to every request
  client.interceptors.request.use((config) => {
    const token = store.getState().auth.accessToken;
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
  });

  // Auto-refresh on 401
  let isRefreshing = false;
  let failedQueue: Array<{ resolve: (token: string) => void; reject: (err: unknown) => void }> = [];

  const processQueue = (error: unknown, token: string | null) => {
    failedQueue.forEach(p => error ? p.reject(error) : p.resolve(token!));
    failedQueue = [];
  };

  client.interceptors.response.use(
    res => res,
    async (error: AxiosError) => {
      const originalRequest = error.config as typeof error.config & { _retry?: boolean };

      if (error.response?.status === 401 && !originalRequest._retry) {
        if (isRefreshing) {
          return new Promise((resolve, reject) => {
            failedQueue.push({ resolve, reject });
          }).then(token => {
            originalRequest.headers!.Authorization = `Bearer ${token}`;
            return client(originalRequest);
          });
        }

        originalRequest._retry = true;
        isRefreshing = true;

        const refreshToken = store.getState().auth.refreshToken;
        if (!refreshToken) {
          store.dispatch(logout());
          return Promise.reject(error);
        }

        try {
          const { data } = await axios.post(`${BASE_URL}/auth/refresh`, { refreshToken });
          store.dispatch(setTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken }));
          processQueue(null, data.accessToken);
          originalRequest.headers!.Authorization = `Bearer ${data.accessToken}`;
          return client(originalRequest);
        } catch (refreshError) {
          processQueue(refreshError, null);
          store.dispatch(logout());
          return Promise.reject(refreshError);
        } finally {
          isRefreshing = false;
        }
      }

      return Promise.reject(error);
    }
  );

  return client;
}

export const api = createApiClient();

// Typed API calls
export const authAPI = {
  register: (data: { email: string; password: string; username: string; displayName: string }) =>
    api.post('/auth/register', data),
  login: (email: string, password: string) =>
    api.post('/auth/login', { email, password }),
  loginGoogle: (idToken: string) =>
    api.post('/auth/google', { idToken }),
  me: () => api.get('/auth/me'),
};

export const territoryAPI = {
  getViewport: (bounds: { minLng: number; minLat: number; maxLng: number; maxLat: number; zoom?: number }) =>
    api.get('/territories/viewport', { params: bounds }),
  getMyTerritory: () => api.get('/territories/me'),
};

export const leaderboardAPI = {
  global: (page = 1) => api.get('/leaderboard/global', { params: { page } }),
  city: (city: string, page = 1) => api.get(`/leaderboard/city/${encodeURIComponent(city)}`, { params: { page } }),
  myRank: () => api.get('/leaderboard/me/rank'),
};

export const sessionAPI = {
  list: (page = 1) => api.get('/sessions', { params: { page } }),
};
