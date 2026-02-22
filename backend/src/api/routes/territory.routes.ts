import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.middleware';
import { territoryService } from '../../services/territory.service';
import { AppError } from '../../middleware/error.middleware';

export const territoryRouter = Router();

// All territory routes require auth
territoryRouter.use(requireAuth);

/**
 * GET /api/v1/territories/viewport
 * Get all territories within a map viewport bounding box
 */
territoryRouter.get('/viewport', async (req, res, next) => {
  try {
    const schema = z.object({
      minLng: z.string().transform(Number),
      minLat: z.string().transform(Number),
      maxLng: z.string().transform(Number),
      maxLat: z.string().transform(Number),
      zoom: z.string().transform(Number).optional(),
    });
    const { minLng, minLat, maxLng, maxLat, zoom } = schema.parse(req.query);

    // Simplify more aggressively at lower zoom levels
    const simplify = zoom !== undefined ? Math.max(0, 0.0001 * (15 - zoom) * 0.5) : 0.0001;

    const territories = await territoryService.getTerritoriesInBbox(
      minLng, minLat, maxLng, maxLat, simplify
    );

    res.json({ territories });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/territories/me
 * Get the authenticated user's full territory
 */
territoryRouter.get('/me', async (req, res, next) => {
  try {
    const territory = await territoryService.getUserTerritory(req.user.sub);
    res.json({ territory });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/territories/:userId
 * Get another user's territory
 */
territoryRouter.get('/:userId', async (req, res, next) => {
  try {
    const territory = await territoryService.getUserTerritory(req.params.userId);
    if (!territory) throw new AppError(404, 'Territory not found');
    res.json({ territory });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/territories/commit
 * Commit a completed session polygon — triggers intersection logic
 */
territoryRouter.post('/commit', async (req, res, next) => {
  try {
    const schema = z.object({
      geoJsonPolygon: z.object({
        type: z.literal('Polygon'),
        coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
      }),
      sessionId: z.string().uuid(),
      city: z.string().optional(),
      country: z.string().optional(),
    });

    const data = schema.parse(req.body);
    const result = await territoryService.commitPolygon({
      userId: req.user.sub,
      geoJsonPolygon: data.geoJsonPolygon,
      sessionId: data.sessionId,
      city: data.city,
      country: data.country,
    });

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
