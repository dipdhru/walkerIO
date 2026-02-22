# Multi-stage build for minimal production image
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm ci --only=production=false

COPY . .
RUN npm run build

# ── Production image ──────────────────────────────────────────
FROM node:20-alpine AS production

RUN apk add --no-cache dumb-init

WORKDIR /app

# Only copy production dependencies
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy compiled output
COPY --from=builder /app/dist ./dist

# Non-root user for security
RUN addgroup -g 1001 -S walkerio && adduser -S walkerio -u 1001
USER walkerio

EXPOSE 3000

# dumb-init: proper PID 1 handling (signal forwarding, zombie reaping)
CMD ["dumb-init", "node", "dist/index.js"]
