import { Router } from 'express';
import { z } from 'zod';
import { authService } from '../../services/auth.service';
import { requireAuth } from '../../middleware/auth.middleware';
import { authRateLimit } from '../../middleware/rateLimit.middleware';
import { AppError } from '../../middleware/error.middleware';

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  username: z.string().min(3).max(30).regex(/^[a-z0-9_]+$/i),
  displayName: z.string().min(1).max(50),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post('/register', authRateLimit, async (req, res, next) => {
  try {
    const data = registerSchema.parse(req.body);
    const result = await authService.registerEmail(data);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', authRateLimit, async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const result = await authService.loginEmail(email, password);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

authRouter.post('/google', authRateLimit, async (req, res, next) => {
  try {
    const { idToken } = z.object({ idToken: z.string() }).parse(req.body);
    const result = await authService.loginGoogle(idToken);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

authRouter.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
    const tokens = await authService.refreshToken(refreshToken);
    res.json(tokens);
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await authService.getUserProfile(req.user.sub);
    res.json(user);
  } catch (err) {
    next(err);
  }
});

authRouter.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const schema = z.object({
      displayName: z.string().min(1).max(50).optional(),
      username: z.string().min(3).max(30).regex(/^[a-z0-9_]+$/i).optional(),
      city: z.string().max(100).optional(),
    });
    const updates = schema.parse(req.body);
    const user = await authService.updateProfile(req.user.sub, updates);
    res.json(user);
  } catch (err) {
    next(err);
  }
});
