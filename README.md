# Walker.IO — Live GPS Territory Game

> Multiplayer real-time territory capture via physical movement. Walk more, own more.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENTS (Mobile)                          │
│   React Native + Mapbox SDK + Background GPS + Socket.IO Client  │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTPS / WSS
┌────────────────────────────▼────────────────────────────────────┐
│                     AWS Application Load Balancer                │
│                  (sticky sessions for WebSocket)                 │
└──────┬──────────────────────┬───────────────────────────────────┘
       │ REST API              │ WebSocket (Socket.IO)
┌──────▼──────┐        ┌──────▼──────────────────────────────────┐
│ Express API │        │        Socket.IO Cluster                  │
│  (Auth,     │        │  (GPS updates, territory pushes,          │
│  Territory, │        │   steal events, leaderboard diffs)        │
│  Leaderboard│        │   backed by Redis Pub/Sub adapter         │
└──────┬──────┘        └──────┬───────────────────────────────────┘
       │                      │
┌──────▼──────────────────────▼───────────────────────────────────┐
│                        Service Layer                              │
│  TerritoryService │ AntiCheatService │ GPSBatchService │ Auth    │
└──────┬──────────────────────┬───────────────────────────────────┘
       │                      │
┌──────▼──────┐        ┌──────▼──────┐
│  PostgreSQL │        │    Redis    │
│  + PostGIS  │        │  (cache,    │
│  (spatial   │        │   pub/sub,  │
│   queries)  │        │   sessions) │
└─────────────┘        └─────────────┘
```

---

## Technology Decisions

### Mobile: React Native (over Flutter)
- **Reason**: Faster MVP, shared TypeScript with backend, @rnmapbox/maps maturity,
  react-native-background-geolocation is the gold standard for background GPS,
  larger hiring pool for a seed-stage startup.
- Flutter is better for pixel-perfect UI performance — revisit at Series A.

### Backend: Node.js + Express + TypeScript (over FastAPI)
- **Reason**: Socket.IO is the industry standard for real-time; Python's asyncio
  adds complexity for <3s territory sync requirement. Node handles 100k concurrent
  connections per instance with proper tuning.
- FastAPI is better for CPU-heavy ML inference — not our bottleneck.

---

## Core Game Flow

```
User walks GPS path
       │
       ▼
GPS points batched (every 3s or 20m distance delta)
       │
       ▼
Anti-cheat validation (speed threshold, spoof detection)
       │
       ▼
Polygon generated from convex hull / alpha shape
       │
       ▼
PostGIS: ST_Intersects scan against nearby territories
       │
     ┌─┴──────────────────┐
  No Intersect         Intersects
     │                    │
  Insert new          Compare total areas
  territory           │
                    ┌──┴──────────────────┐
               A > B area            A < B area     A == B
               A steals              A loses        50/50 split
               ST_Union              ST_Difference  ST_Union/2
                    │
                    ▼
           Broadcast via WebSocket to all clients
           in geographic room (0.1° × 0.1° geohash cell)
```

---

## Scaling Plan: 0 → 100k Concurrent Users

### Phase 1 (0–1k users): Single Instance
- 1× EC2 t3.large (backend)
- 1× RDS db.t3.medium (PostgreSQL + PostGIS)
- 1× ElastiCache t3.micro (Redis)
- Estimated cost: ~$150/month

### Phase 2 (1k–10k users): Horizontal Scale
- 3× EC2 c5.xlarge behind ALB (sticky sessions)
- RDS db.r5.large with read replica
- ElastiCache cluster mode (3 shards)
- Socket.IO with Redis adapter for cross-node pub/sub

### Phase 3 (10k–100k users): Cloud-Native
- EKS (Kubernetes) with HPA (auto-scale on CPU/connection count)
- Aurora PostgreSQL (PostGIS extension) — Multi-AZ, auto-scaling storage
- ElastiCache Redis cluster (6 shards × 2 replicas)
- CDN (CloudFront) for static assets and map tiles
- Separate WebSocket service (stateful pods with sticky ALB)
- Background job workers for leaderboard computation (SQS + Lambda)

### Geographic Sharding Strategy
- Partition territory data by geohash prefix (first 3 chars = ~5km × 5km cell)
- Each geographic cell = independent WebSocket room → reduces broadcast scope
- Intersections only queried within adjacent cells (8-neighbor search)

---

## Anti-Cheat System

1. **Speed Threshold**: Flag GPS points where speed > 50 km/h (running max ~36 km/h)
2. **Acceleration Check**: Impossible acceleration between consecutive points
3. **GPS Jitter Detection**: Variance analysis of stationary GPS drift vs. movement
4. **Spoofing Detection**:
   - Mock location API detection on device (reported via app)
   - Server-side: GPS altitude changes inconsistent with terrain (elevation API)
   - Velocity vector consistency check (can't teleport between points)
5. **Session Invalidation**: >3 violations in session → session flagged, area not counted
6. **Human Review Queue**: Sessions >10km² in single session → queued for review

---

## DevOps Deployment

### Infrastructure as Code: Terraform + AWS
- VPC with public/private subnets across 3 AZs
- EKS cluster for backend microservices
- RDS Aurora PostgreSQL (PostGIS)
- ElastiCache Redis
- ALB with SSL termination (ACM)
- Route 53 for DNS
- CloudWatch + Datadog for observability

### CI/CD: GitHub Actions
- PR → lint + test + build Docker image
- Merge to main → push to ECR → rolling deploy to EKS
- Database migrations run as Kubernetes Job before deployment

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v20+
- [Docker](https://docs.docker.com/get-docker/) & Docker Compose v2
- [React Native environment](https://reactnative.dev/docs/environment-setup) (for mobile development)
  - iOS: Xcode 15+ (macOS only)
  - Android: Android Studio + JDK 17

---

## Running the Backend

### Option A — Docker Compose (recommended)

Spins up PostgreSQL + PostGIS, Redis, and the backend API together. Migrations
run automatically on first start.

```bash
# From the repo root
docker compose -f infrastructure/docker/docker-compose.yml up
```

| Service        | URL                         |
| -------------- | --------------------------- |
| Backend API    | http://localhost:3000       |
| WebSocket      | ws://localhost:3000         |

Health check: `curl http://localhost:3000/health`

**Optional debug UIs** (add `--profile debug` to enable):

```bash
docker compose -f infrastructure/docker/docker-compose.yml --profile debug up
```

| Tool            | URL                   | Credentials                          |
| --------------- | --------------------- | ------------------------------------- |
| Redis Commander | http://localhost:8081 | —                                     |
| pgAdmin         | http://localhost:5050 | dev@walkerio.app / dev_password       |

---

### Option B — Manual local setup

```bash
cd backend
npm install

# Copy env file and set values
cp .env.example .env
# Edit .env — at minimum set DATABASE_URL, REDIS_URL, JWT_SECRET

# Start the dev server (hot-reload via ts-node-dev)
npm run dev
```

The server runs at **http://localhost:3000**.

---

## Running the Mobile App

```bash
cd mobile
npm install

# Start Metro bundler
npm start

# In a separate terminal — run on iOS simulator
npm run ios

# Or run on Android emulator / device
npm run android
```

> **Mapbox token**: set `MAPBOX_ACCESS_TOKEN` in your environment or a
> `.env` file at `mobile/` before running. See the
> [@rnmapbox/maps setup guide](https://github.com/rnmapbox/maps/blob/main/plugin/README.md).

---

## Running Tests

### Backend tests

```bash
cd backend
npm test            # run all tests once
npm test -- --watch # watch mode
```

Tests use **Jest** with `ts-jest`. They run in-band (`--runInBand`) by default
to avoid port conflicts.

### Mobile tests

```bash
cd mobile
npm test
```

Tests use **Jest** + **@testing-library/react-native**.

### Type checking & linting

```bash
# Backend
cd backend
npm run lint        # ESLint
npm run build       # TypeScript compile check

# Mobile
cd mobile
npm run lint        # ESLint
npm run type-check  # tsc --noEmit
```

---

## Viewing Live Data

With the Docker stack running (`--profile debug`):

- **Redis Commander** → http://localhost:8081 — browse cached territory data,
  Socket.IO session keys, leaderboard sorted sets.
- **pgAdmin** → http://localhost:5050 — query the PostGIS tables
  (`territories`, `users`, `sessions`) and run spatial queries.

You can also connect directly:

```bash
# PostgreSQL
psql postgresql://walkerio:walkerio_dev_password@localhost:5432/walkerio

# Redis CLI
redis-cli -h localhost -p 6379
```

---

## Repository Structure

```
walkerIO/
├── backend/                   # Node.js + Express + Socket.IO
│   ├── src/
│   │   ├── api/
│   │   │   ├── routes/        # Express route definitions
│   │   │   └── controllers/   # Request handlers
│   │   ├── services/          # Business logic
│   │   ├── websocket/         # Socket.IO event handlers
│   │   ├── middleware/        # Auth, rate limit, error handling
│   │   ├── models/            # DB query functions
│   │   ├── config/            # DB, Redis, env config
│   │   └── utils/             # Geo math, logger
│   ├── migrations/            # SQL migration files
│   ├── Dockerfile
│   └── package.json
├── mobile/                    # React Native + Mapbox
│   └── src/
│       ├── screens/           # UI screens
│       ├── components/        # Reusable UI components
│       ├── services/          # GPS, WebSocket, Auth
│       ├── store/             # Redux Toolkit state
│       ├── hooks/             # Custom React hooks
│       └── utils/             # Geo utilities
├── infrastructure/
│   ├── docker/                # Docker Compose files
│   ├── k8s/                   # Kubernetes manifests
│   └── terraform/             # AWS infrastructure
└── docs/                      # Architecture decisions
```
