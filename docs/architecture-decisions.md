# Architecture Decision Records (ADRs) — Walker.IO

## ADR-001: Mobile Framework — React Native

**Status**: Accepted

**Context**: Chose between Flutter and React Native.

**Decision**: React Native for MVP.

**Rationale**:
- Shared TypeScript codebase with backend reduces cognitive overhead
- `react-native-background-geolocation` is the most battle-tested background GPS library
- `@rnmapbox/maps` has full Mapbox GL feature parity
- Faster hire cycle for a seed-stage startup (3× more RN engineers than Flutter)
- Socket.IO JS client integrates natively
- Larger open-source ecosystem for fitness/health app primitives

**Flutter revisit criteria**: At 100k MAU if frame rate on low-end Android becomes a retention problem.

---

## ADR-002: Backend — Node.js + Socket.IO (over FastAPI)

**Status**: Accepted

**Context**: Chose between Node.js/Express/Socket.IO and Python/FastAPI/WebSockets.

**Decision**: Node.js for MVP and foreseeable future.

**Rationale**:
- Socket.IO is the industry gold standard for game-like real-time apps
- Node.js event loop handles 50k+ concurrent WebSocket connections per instance
- Redis adapter for Socket.IO is first-class and production-proven
- Python asyncio adds complexity without benefiting our workload type
- FastAPI is optimal for ML inference — not applicable here

**Migration criteria**: If ML features (route prediction, territory AI) are added as core features, a FastAPI microservice can be added alongside Node.js.

---

## ADR-003: Territory as Single MULTIPOLYGON per user

**Status**: Accepted

**Context**: Chose between one row per polygon session vs. one row per user (cumulative MULTIPOLYGON).

**Decision**: Single MULTIPOLYGON row per user, merged via ST_Union.

**Rationale**:
- Leaderboard query is O(1) — just read `area_m2` from users table (denormalized)
- ST_Intersects queries are faster with single geometry vs. multi-row UNION
- MULTIPOLYGON handles disconnected territory islands natively
- GIST index on single geometry is more efficient
- Territory merge is atomic (single UPDATE via ST_Union)

**Trade-off**: History is in `territory_history` table (separate). Geometry before/after snapshots allow reconstruction if needed.

---

## ADR-004: GPS Batching at 3-second intervals

**Status**: Accepted

**Context**: Chose between per-point streaming and batched updates.

**Decision**: Client-side buffer, 3-second server send interval.

**Rationale**:
- Walking speed: ~1.4 m/s → 4.2m in 3s → spatial resolution sufficient for territory polygons
- Reduces WebSocket messages by ~20× vs per-point (GPS fires at 1–2Hz)
- Gracefully handles brief connectivity loss (client buffers offline)
- Anti-cheat validation per batch (not per-point) is more efficient server-side
- Ramer-Douglas-Peucker applied before commit reduces polygon vertex count

**Target P99 latency for commit propagation**: <3 seconds from walk completion to map update for all nearby users.

---

## ADR-005: Leaderboard via Redis Sorted Sets

**Status**: Accepted

**Context**: Chose between DB-only leaderboard and Redis-cached.

**Decision**: Redis Sorted Sets as primary leaderboard store.

**Rationale**:
- ZREVRANGE is O(log N + M) — constant time rank lookup for any position
- ZREVRANK gives O(log N) user rank without scanning all entries
- Score updates (territory commit) are O(log N) — perfect for real-time
- DB serves as persistent truth; Redis is rebuilt from DB on cold start or TTL expiry
- Horizontal scaling: all nodes share same Redis cluster → consistent leaderboard

---

## ADR-006: Geographic WebSocket Rooms via Geohash

**Status**: Accepted

**Context**: Needed strategy to broadcast territory updates only to nearby clients.

**Decision**: Geohash precision-3 (~78km² cells) for room routing.

**Rationale**:
- Avoids global broadcast to all connected clients
- Precision 3 cells are small enough to be relevant but large enough to batch events
- Client joins/leaves rooms as map viewport pans (join_area / leave_area events)
- 8-neighbor cell check prevents missed events at cell boundaries
- Server never knows exact user GPS position (only coarse geohash) → privacy preserving

---

## ADR-007: Anti-Cheat — Server-Side Validation + Client Trust Score

**Status**: Accepted

**Context**: GPS spoofing is the primary exploit vector.

**Decision**: Multi-layer server-side validation with session invalidation.

**Layers**:
1. Speed threshold (50 km/h — sprint max ~36 km/h, buffer for GPS jitter)
2. Acceleration check between consecutive points
3. Future timestamp detection (clock manipulation)
4. Low accuracy point discard (>50m accuracy)
5. Mock location API detection (client-reported + server heuristic)
6. Session area cap (10 km² per session — extreme outlier review)
7. Theoretical area vs distance check (can't capture more than circle with path circumference)

**Philosophy**: Trust but verify. 3 violations per session = invalidation. Violations logged for ML-based pattern detection in future.
