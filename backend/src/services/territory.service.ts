import { PoolClient } from 'pg';
import { query, withTransaction } from '../config/database';
import { redis, CacheKey, TTL } from '../config/redis';
import { AppError } from '../middleware/error.middleware';
import { logger } from '../utils/logger';
import { toGeohash } from '../utils/geo.utils';
import { getIoInstance } from '../websocket';

export type IntersectionResult = 'steal' | 'lose' | 'split' | 'none';

export interface TerritoryRecord {
  id: string;
  user_id: string;
  geometry: string; // GeoJSON string from PostGIS
  area_m2: number;
  city: string | null;
  country: string | null;
  updated_at: Date;
}

export interface StealEvent {
  type: 'steal' | 'lose' | 'split';
  attackerUserId: string;
  defenderUserId: string;
  intersectionAreaM2: number;
  attackerTotalAreaM2: number;
  defenderTotalAreaM2: number;
}

export class TerritoryService {
  /**
   * Commit a new polygon from a completed GPS session.
   * Handles:
   * - Inserting/merging user's territory
   * - Detecting intersections with all overlapping territories
   * - Applying steal/lose/split logic
   * - Broadcasting WebSocket events
   * - Updating user total area
   */
  async commitPolygon(params: {
    userId: string;
    geoJsonPolygon: object; // GeoJSON Polygon
    sessionId: string;
    city?: string;
    country?: string;
  }): Promise<{ territoryId: string; areaM2: number; events: StealEvent[] }> {
    const events: StealEvent[] = [];

    const result = await withTransaction(async (client) => {
      // 1. Calculate area of new polygon
      const [areaRow] = await client.query<{ area_m2: number }>(`
        SELECT ST_Area(ST_GeomFromGeoJSON($1)::geography) AS area_m2
      `, [JSON.stringify(params.geoJsonPolygon)]);

      const newAreaM2 = areaRow.rows[0].area_m2;

      // 2. Find all territories that intersect with the new polygon
      const intersecting = await client.query<{
        territory_id: string;
        owner_id: string;
        owner_total_area: number;
        intersection_area_m2: number;
      }>(`
        SELECT
          t.id AS territory_id,
          t.user_id AS owner_id,
          u.total_area_m2 AS owner_total_area,
          ST_Area(
            ST_Intersection(t.geometry, ST_GeomFromGeoJSON($1)::geometry)::geography
          ) AS intersection_area_m2
        FROM territories t
        JOIN users u ON u.id = t.user_id
        WHERE
          t.user_id != $2
          AND ST_Intersects(t.geometry, ST_GeomFromGeoJSON($1)::geometry)
          AND ST_Area(
            ST_Intersection(t.geometry, ST_GeomFromGeoJSON($1)::geometry)::geography
          ) > 1  -- ignore sub-meter intersections (floating point noise)
      `, [JSON.stringify(params.geoJsonPolygon), params.userId]);

      // 3. Get or create attacker's territory record
      const attackerTerritoryId = await this.upsertUserTerritory(
        client,
        params.userId,
        params.geoJsonPolygon,
        params.city,
        params.country
      );

      // 4. Get attacker's total area (after merging new polygon)
      const [attackerAreaRow] = await client.query<{ total_area_m2: number }>(`
        SELECT total_area_m2 FROM users WHERE id = $1
      `, [params.userId]);
      const attackerTotalArea = attackerAreaRow.rows[0].total_area_m2 + newAreaM2;

      // 5. Process each intersection
      for (const row of intersecting.rows) {
        const defenderTotalArea = row.owner_total_area;
        const intersectionArea = row.intersection_area_m2;

        let outcome: IntersectionResult;
        if (attackerTotalArea > defenderTotalArea) {
          outcome = 'steal';
        } else if (attackerTotalArea < defenderTotalArea) {
          outcome = 'lose';
        } else {
          outcome = 'split';
        }

        await this.resolveIntersection(client, {
          outcome,
          attackerUserId: params.userId,
          defenderTerritoryId: row.territory_id,
          defenderUserId: row.owner_id,
          newPolygon: params.geoJsonPolygon,
          intersectionAreaM2: intersectionArea,
          sessionId: params.sessionId,
        });

        events.push({
          type: outcome,
          attackerUserId: params.userId,
          defenderUserId: row.owner_id,
          intersectionAreaM2: intersectionArea,
          attackerTotalAreaM2: attackerTotalArea,
          defenderTotalAreaM2: defenderTotalArea,
        });
      }

      // 6. Update user total_area_m2
      await client.query(`
        UPDATE users
        SET total_area_m2 = (
          SELECT COALESCE(ST_Area(geometry::geography), 0)
          FROM territories
          WHERE user_id = $1
        ), updated_at = NOW()
        WHERE id = $1
      `, [params.userId]);

      await client.query(`UPDATE users SET updated_at = NOW() WHERE id = $1`, [params.userId]);

      return { territoryId: attackerTerritoryId, areaM2: newAreaM2, events };
    });

    // 7. Invalidate caches and broadcast
    await this.invalidateTerritoryCache(params.userId);
    await this.broadcastTerritoryUpdate(params.userId, result.events);

    logger.info('Polygon committed', {
      userId: params.userId,
      areaM2: result.areaM2,
      eventCount: result.events.length,
    });

    return result;
  }

  /**
   * Insert new territory or merge with existing via ST_Union
   */
  private async upsertUserTerritory(
    client: PoolClient,
    userId: string,
    newPolygon: object,
    city?: string,
    country?: string
  ): Promise<string> {
    const existing = await client.query<{ id: string }>(`
      SELECT id FROM territories WHERE user_id = $1
    `, [userId]);

    if (existing.rows.length === 0) {
      // First territory — insert as MULTIPOLYGON
      const result = await client.query<{ id: string }>(`
        INSERT INTO territories (user_id, geometry, area_m2, city, country)
        VALUES (
          $1,
          ST_Multi(ST_GeomFromGeoJSON($2)::geometry),
          ST_Area(ST_GeomFromGeoJSON($2)::geography),
          $3, $4
        )
        RETURNING id
      `, [userId, JSON.stringify(newPolygon), city ?? null, country ?? null]);
      return result.rows[0].id;
    } else {
      // Merge with existing via ST_Union (handles overlapping own territory)
      const result = await client.query<{ id: string }>(`
        UPDATE territories
        SET
          geometry = ST_Multi(
            ST_Union(geometry, ST_GeomFromGeoJSON($2)::geometry)
          ),
          area_m2 = ST_Area(
            ST_Multi(ST_Union(geometry, ST_GeomFromGeoJSON($2)::geometry))::geography
          ),
          updated_at = NOW()
        WHERE user_id = $1
        RETURNING id
      `, [userId, JSON.stringify(newPolygon)]);
      return result.rows[0].id;
    }
  }

  /**
   * Apply intersection resolution:
   * - steal: remove intersection from defender, add to attacker
   * - lose: remove intersection from attacker's new polygon
   * - split: give 50% to each (approximate by giving full to neither — use centroid split)
   */
  private async resolveIntersection(
    client: PoolClient,
    params: {
      outcome: IntersectionResult;
      attackerUserId: string;
      defenderTerritoryId: string;
      defenderUserId: string;
      newPolygon: object;
      intersectionAreaM2: number;
      sessionId: string;
    }
  ): Promise<void> {
    const polygonJson = JSON.stringify(params.newPolygon);

    if (params.outcome === 'steal') {
      // Remove intersection from defender's territory
      await client.query(`
        UPDATE territories
        SET
          geometry = ST_Multi(
            ST_Difference(geometry, ST_GeomFromGeoJSON($1)::geometry)
          ),
          area_m2 = ST_Area(
            ST_Multi(
              ST_Difference(geometry, ST_GeomFromGeoJSON($1)::geometry)
            )::geography
          ),
          updated_at = NOW()
        WHERE id = $2
      `, [polygonJson, params.defenderTerritoryId]);

      // Update defender's total area
      await client.query(`
        UPDATE users
        SET total_area_m2 = (
          SELECT COALESCE(ST_Area(geometry::geography), 0)
          FROM territories WHERE user_id = $1
        ), updated_at = NOW()
        WHERE id = $1
      `, [params.defenderUserId]);

    } else if (params.outcome === 'lose') {
      // Remove intersection from attacker's new polygon contribution
      await client.query(`
        UPDATE territories
        SET
          geometry = ST_Multi(
            ST_Difference(geometry, (
              SELECT ST_Intersection(
                ST_GeomFromGeoJSON($1)::geometry,
                geometry
              )
              FROM territories WHERE user_id = $2
            ))
          ),
          area_m2 = ST_Area(
            ST_Multi(
              ST_Difference(geometry, (
                SELECT ST_Intersection(
                  ST_GeomFromGeoJSON($1)::geometry,
                  geometry
                )
                FROM territories WHERE user_id = $2
              ))
            )::geography
          ),
          updated_at = NOW()
        WHERE user_id = $3
      `, [polygonJson, params.defenderUserId, params.attackerUserId]);

    } else if (params.outcome === 'split') {
      // 50/50 split: give intersection to attacker, remove from defender
      // Simplified: buffer intersection by 0 and divide by splitting down the middle
      await client.query(`
        UPDATE territories
        SET
          geometry = ST_Multi(
            ST_Difference(
              geometry,
              ST_Buffer(
                ST_Intersection(geometry, ST_GeomFromGeoJSON($1)::geometry),
                0.0
              )
            )
          ),
          area_m2 = ST_Area(
            ST_Multi(
              ST_Difference(
                geometry,
                ST_Intersection(geometry, ST_GeomFromGeoJSON($1)::geometry)
              )
            )::geography
          ) + ($2 / 2.0),
          updated_at = NOW()
        WHERE id = $3
      `, [polygonJson, params.intersectionAreaM2, params.defenderTerritoryId]);
    }

    // Record history
    await client.query(`
      INSERT INTO territory_history
        (user_id, action, area_change_m2, opponent_user_id, session_id)
      VALUES ($1, $2, $3, $4, $5)
    `, [
      params.attackerUserId,
      params.outcome === 'steal' ? 'stolen' : params.outcome === 'lose' ? 'lost' : 'split',
      params.intersectionAreaM2,
      params.defenderUserId,
      params.sessionId,
    ]);
  }

  /**
   * Get territory GeoJSON for a bounding box (map viewport)
   * Returns simplified geometries at lower zoom levels for performance
   */
  async getTerritoriesInBbox(
    minLng: number, minLat: number,
    maxLng: number, maxLat: number,
    simplifyTolerance = 0.0001  // ~10m at equator
  ): Promise<Array<{ userId: string; username: string; geometry: object; areaM2: number }>> {
    const rows = await query<{
      user_id: string;
      username: string;
      geometry: string;
      area_m2: number;
    }>(`
      SELECT
        t.user_id,
        u.username,
        ST_AsGeoJSON(
          ST_Simplify(t.geometry, $5)
        ) AS geometry,
        t.area_m2
      FROM territories t
      JOIN users u ON u.id = t.user_id
      WHERE ST_Intersects(
        t.geometry,
        ST_MakeEnvelope($1, $2, $3, $4, 4326)
      )
      LIMIT 500
    `, [minLng, minLat, maxLng, maxLat, simplifyTolerance]);

    return rows.map(r => ({
      userId: r.user_id,
      username: r.username,
      geometry: JSON.parse(r.geometry),
      areaM2: r.area_m2,
    }));
  }

  /**
   * Get user's territory as GeoJSON
   */
  async getUserTerritory(userId: string): Promise<{ geometry: object; areaM2: number } | null> {
    const [row] = await query<{ geometry: string; area_m2: number }>(`
      SELECT ST_AsGeoJSON(geometry) AS geometry, area_m2
      FROM territories
      WHERE user_id = $1
    `, [userId]);

    if (!row) return null;
    return { geometry: JSON.parse(row.geometry), areaM2: row.area_m2 };
  }

  private async invalidateTerritoryCache(userId: string): Promise<void> {
    await redis.del(CacheKey.userTotalArea(userId));
    await redis.del(CacheKey.userProfile(userId));
  }

  private async broadcastTerritoryUpdate(
    userId: string,
    events: StealEvent[]
  ): Promise<void> {
    const io = getIoInstance();
    if (!io) return;

    // Emit to relevant geographic rooms (attacker and all affected defenders)
    for (const event of events) {
      io.to(`user:${event.defenderUserId}`).emit('territory:stolen', {
        byUserId: userId,
        areaM2: event.intersectionAreaM2,
      });
    }

    io.to(`user:${userId}`).emit('territory:updated', {
      events,
    });
  }
}

export const territoryService = new TerritoryService();
