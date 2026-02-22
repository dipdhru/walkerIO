-- ============================================================
-- Walker.IO — Initial Database Schema
-- PostgreSQL + PostGIS
-- Migration: 001_initial_schema
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- for username search

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email               VARCHAR(255) UNIQUE,
    username            VARCHAR(50) UNIQUE NOT NULL,
    display_name        VARCHAR(100) NOT NULL,
    avatar_url          TEXT,
    auth_provider       VARCHAR(20) NOT NULL DEFAULT 'email',  -- email | google | apple
    auth_provider_id    VARCHAR(255),
    password_hash       VARCHAR(255),

    -- Game stats (denormalized for leaderboard performance)
    total_area_m2       DOUBLE PRECISION NOT NULL DEFAULT 0,

    -- Location context
    city                VARCHAR(100),
    country             VARCHAR(100),
    country_code        CHAR(2),

    -- Account state
    is_active           BOOLEAN NOT NULL DEFAULT true,
    is_banned           BOOLEAN NOT NULL DEFAULT false,
    ban_reason          TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique constraint: one account per OAuth provider+id combination
CREATE UNIQUE INDEX users_auth_provider_id_idx
    ON users (auth_provider, auth_provider_id)
    WHERE auth_provider_id IS NOT NULL;

-- Full-text search on username / display_name
CREATE INDEX users_username_trgm_idx ON users USING GIN (username gin_trgm_ops);
CREATE INDEX users_city_idx ON users (city) WHERE city IS NOT NULL;

-- ============================================================
-- TERRITORIES
-- Each user has exactly ONE territory row (MULTIPOLYGON).
-- Territory is built up over time via ST_Union.
-- MULTIPOLYGON handles disconnected territory islands natively.
-- ============================================================
CREATE TABLE territories (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- PostGIS MULTIPOLYGON in WGS84 (SRID 4326)
    geometry    GEOMETRY(MULTIPOLYGON, 4326) NOT NULL,

    -- Denormalized area — kept in sync by trigger
    area_m2     DOUBLE PRECISION NOT NULL DEFAULT 0,

    -- Geographic context (for city leaderboard scoping)
    city        VARCHAR(100),
    country     VARCHAR(100),

    -- Display
    color       CHAR(7) NOT NULL DEFAULT '#0066FF',  -- hex color per user

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One territory record per user (union of all their polygons)
CREATE UNIQUE INDEX territories_user_id_unique_idx ON territories (user_id);

-- GIST spatial index — essential for ST_Intersects, ST_Within, ST_DWithin queries
CREATE INDEX territories_geometry_gist_idx ON territories USING GIST (geometry);
CREATE INDEX territories_city_idx ON territories (city) WHERE city IS NOT NULL;

-- ============================================================
-- TERRITORY HISTORY
-- Append-only audit log of all territory changes.
-- Used for: replay, dispute resolution, analytics.
-- ============================================================
CREATE TABLE territory_history (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    territory_id        UUID REFERENCES territories(id) ON DELETE SET NULL,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Action type
    action              VARCHAR(20) NOT NULL,
    -- 'created'  — first territory polygon
    -- 'expanded' — user added area (no conflict)
    -- 'stolen'   — user stole area from opponent
    -- 'lost'     — user lost area to opponent
    -- 'split'    — equal-area 50/50 exchange

    -- Geometry snapshots for replay/debugging (nullable to save space in production)
    geometry_before     GEOMETRY(MULTIPOLYGON, 4326),
    geometry_after      GEOMETRY(MULTIPOLYGON, 4326),

    area_change_m2      DOUBLE PRECISION,    -- positive = gained, negative = lost
    opponent_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    session_id          UUID,                -- reference (not FK — sessions may be pruned)

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX territory_history_user_id_idx     ON territory_history (user_id);
CREATE INDEX territory_history_created_at_idx  ON territory_history (created_at DESC);
CREATE INDEX territory_history_session_id_idx  ON territory_history (session_id);
-- Partial index: only index 'stolen' events (frequent query pattern)
CREATE INDEX territory_history_stolen_idx      ON territory_history (opponent_user_id)
    WHERE action = 'stolen';

-- ============================================================
-- SESSIONS
-- Represents a single GPS tracking session (one run/walk).
-- ============================================================
CREATE TABLE sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at            TIMESTAMPTZ,
    duration_s          INTEGER GENERATED ALWAYS AS (
                            EXTRACT(EPOCH FROM (ended_at - started_at))::INTEGER
                        ) STORED,

    -- Stats
    distance_m          DOUBLE PRECISION NOT NULL DEFAULT 0,
    area_captured_m2    DOUBLE PRECISION NOT NULL DEFAULT 0,
    area_stolen_m2      DOUBLE PRECISION NOT NULL DEFAULT 0,   -- area stolen FROM others
    area_lost_m2        DOUBLE PRECISION NOT NULL DEFAULT 0,   -- area lost TO others

    -- Raw GPS track (stored for audit/replay; can be pruned after 90 days)
    gps_points          JSONB,

    -- Session state
    status              VARCHAR(20) NOT NULL DEFAULT 'active',
    -- active | completed | cancelled | invalidated

    -- Anti-cheat metadata
    violation_count     INTEGER NOT NULL DEFAULT 0,
    anticheat_flags     JSONB,

    -- Device context
    device_platform     VARCHAR(10),   -- ios | android
    app_version         VARCHAR(20),

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX sessions_user_id_idx     ON sessions (user_id);
CREATE INDEX sessions_status_idx      ON sessions (status) WHERE status = 'active';
CREATE INDEX sessions_started_at_idx  ON sessions (started_at DESC);

-- ============================================================
-- LEADERBOARD SNAPSHOTS
-- Point-in-time snapshots for historical leaderboard tracking.
-- Live leaderboard uses Redis sorted sets; this is the durable record.
-- ============================================================
CREATE TABLE leaderboard_snapshots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope           VARCHAR(20) NOT NULL DEFAULT 'global',  -- global | city | country
    scope_value     VARCHAR(100),   -- city/country name (null for global)
    rank            INTEGER NOT NULL,
    total_area_m2   DOUBLE PRECISION NOT NULL,
    snapshot_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX leaderboard_snapshots_scope_idx
    ON leaderboard_snapshots (scope, scope_value, rank);
CREATE INDEX leaderboard_snapshots_user_idx
    ON leaderboard_snapshots (user_id, scope);

-- ============================================================
-- TRIGGERS
-- ============================================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER territories_updated_at
    BEFORE UPDATE ON territories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Sync territory area_m2 from geometry on every update
CREATE OR REPLACE FUNCTION sync_territory_area()
RETURNS TRIGGER AS $$
BEGIN
    NEW.area_m2 = ST_Area(NEW.geometry::geography);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER territories_sync_area
    BEFORE INSERT OR UPDATE OF geometry ON territories
    FOR EACH ROW EXECUTE FUNCTION sync_territory_area();

-- Sync user total_area_m2 when territory changes
CREATE OR REPLACE FUNCTION sync_user_total_area()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE users
    SET total_area_m2 = COALESCE(NEW.area_m2, 0),
        updated_at = NOW()
    WHERE id = NEW.user_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER territories_sync_user_area
    AFTER INSERT OR UPDATE OF area_m2 ON territories
    FOR EACH ROW EXECUTE FUNCTION sync_user_total_area();

-- ============================================================
-- SAMPLE PostGIS QUERIES (documented here for reference)
-- ============================================================

-- Q1: Check if two users' territories intersect
-- SELECT ST_Intersects(t1.geometry, t2.geometry)
-- FROM territories t1, territories t2
-- WHERE t1.user_id = $1 AND t2.user_id = $2;

-- Q2: Get intersection geometry + area between two territories
-- SELECT
--     ST_AsGeoJSON(ST_Intersection(t1.geometry, t2.geometry)) AS intersection_geom,
--     ST_Area(ST_Intersection(t1.geometry, t2.geometry)::geography) AS intersection_m2
-- FROM territories t1, territories t2
-- WHERE t1.user_id = $1 AND t2.user_id = $2
--   AND ST_Intersects(t1.geometry, t2.geometry);

-- Q3: Steal — remove intersection from defender (ST_Difference)
-- UPDATE territories
-- SET geometry = ST_Multi(
--     ST_Difference(geometry, (
--         SELECT geometry FROM territories WHERE user_id = $attacker_id
--     ))
-- )
-- WHERE user_id = $defender_id;

-- Q4: Merge new polygon into existing territory (ST_Union)
-- UPDATE territories
-- SET geometry = ST_Multi(
--     ST_Union(geometry, ST_GeomFromGeoJSON($new_polygon_geojson))
-- )
-- WHERE user_id = $1;

-- Q5: Find all territories within 5km of a point (for viewport + proximity)
-- SELECT t.user_id, ST_AsGeoJSON(t.geometry) AS geom, t.area_m2
-- FROM territories t
-- WHERE ST_DWithin(
--     t.geometry::geography,
--     ST_Point($lng, $lat)::geography,
--     5000  -- 5km radius in meters
-- );

-- Q6: Find territories in bounding box (viewport query)
-- SELECT t.user_id, u.username, ST_AsGeoJSON(ST_Simplify(t.geometry, 0.0001)) AS geom
-- FROM territories t JOIN users u ON u.id = t.user_id
-- WHERE ST_Intersects(t.geometry, ST_MakeEnvelope($minLng, $minLat, $maxLng, $maxLat, 4326));

-- Q7: Total area owned globally (for stats dashboard)
-- SELECT SUM(area_m2) AS total_claimed_m2, COUNT(DISTINCT user_id) AS active_players
-- FROM territories;

-- ============================================================
-- INDEXES for anti-cheat session queries
-- ============================================================
CREATE INDEX sessions_anticheat_idx
    ON sessions (user_id, started_at DESC)
    WHERE status = 'invalidated';
