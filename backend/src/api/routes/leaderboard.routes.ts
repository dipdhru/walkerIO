import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.middleware';
import { leaderboardService } from '../../services/leaderboard.service';

export const leaderboardRouter = Router();

leaderboardRouter.use(requireAuth);

leaderboardRouter.get('/global', async (req, res, next) => {
  try {
    const page = z.string().default('1').transform(Number).parse(req.query.page as string);
    const result = await leaderboardService.getGlobalLeaderboard(Math.max(1, page));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

leaderboardRouter.get('/city/:city', async (req, res, next) => {
  try {
    const page = z.string().default('1').transform(Number).parse(req.query.page as string);
    const city = z.string().min(1).max(100).parse(req.params.city);
    const result = await leaderboardService.getCityLeaderboard(city, Math.max(1, page));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

leaderboardRouter.get('/me/rank', async (req, res, next) => {
  try {
    const rank = await leaderboardService.getUserRank(req.user.sub);
    res.json(rank);
  } catch (err) {
    next(err);
  }
});
