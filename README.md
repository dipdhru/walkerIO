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
