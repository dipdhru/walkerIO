import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.middleware';
import { query } from '../../config/database';

export const sessionRouter = Router();

sessionRouter.use(requireAuth);

/**
 * GET /api/v1/sessions — list user's sessions (history)
 */
sessionRouter.get('/', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;

    const sessions = await query<{
      id: string;
      started_at: Date;
      ended_at: Date | null;
      distance_m: number;
      area_captured_m2: number;
      area_stolen_m2: number;
      area_lost_m2: number;
      status: string;
    }>(`
      SELECT id, started_at, ended_at, distance_m, area_captured_m2,
             area_stolen_m2, area_lost_m2, status
      FROM sessions
      WHERE user_id = $1
      ORDER BY started_at DESC
      LIMIT $2 OFFSET $3
    `, [req.user.sub, limit, offset]);

    res.json({ sessions, page, limit });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/sessions/:id — session detail
 */
sessionRouter.get('/:id', async (req, res, next) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.id);
    const [session] = await query(`
      SELECT * FROM sessions WHERE id = $1 AND user_id = $2
    `, [sessionId, req.user.sub]);

    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    res.json(session);
  } catch (err) {
    next(err);
  }
});
