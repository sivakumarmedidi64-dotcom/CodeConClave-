# CodeConClave Backend — Production Dockerfile
# Multi-stage: build with all deps, run with prod deps only

# ---- Build Stage ----
FROM node:20-alpine AS builder

WORKDIR /app

# Install build deps for native modules
RUN apk add --no-cache python3 make g++

# Copy package files first (for cache)
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY shared/tsconfig.json shared/tsconfig.json
COPY backend/package.json backend/package.json
COPY backend/tsconfig.json backend/tsconfig.json

# Install all workspace deps (including dev for build)
RUN npm ci --workspaces --include-workspace-root

# Copy source code
COPY shared/src ./shared/src
COPY backend/src ./backend/src

# Build shared first
RUN npm run build --workspace @codeconclave/shared

# Build backend
RUN npm run build --workspace @codeconclave/backend

# ---- Runner Stage ----
FROM node:20-alpine AS runner

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

# Copy built artifacts from builder
COPY --from=builder --chown=nodejs:nodejs /app/shared/dist ./shared/dist
COPY --from=builder --chown=nodejs:nodejs /app/backend/dist ./backend/dist
COPY --from=builder --chown=nodejs:nodejs /app/backend/package.json ./backend/package.json
COPY --from=builder --chown=nodejs:nodejs /app/shared/package.json ./shared/package.json

# Install production dependencies only
RUN npm ci --workspace @codeconclave/backend --omit=dev --ignore-scripts

USER nodejs

EXPOSE 4000

ENV NODE_ENV=production
ENV PORT=4000

WORKDIR /app/backend

CMD ["node", "dist/server.js"]