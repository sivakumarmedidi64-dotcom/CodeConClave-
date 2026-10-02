# CodeConClave frontend — production Docker image.
# Strategy A: dedicated frontend image built with the monorepo root as the Docker
# build context:  docker build -f frontend/Dockerfile .
# Deployment/build-system only. No application source changes.
# No secrets are baked into the image; all runtime config comes from Railway env.
#
# Why repo root as context: it guarantees Railway's Docker build resolves this file
# (frontend/Dockerfile) and does NOT auto-select the backend /Dockerfile that exists
# when a Frontend Root Directory of "/" exposes it. .dockerignore (repo root) already
# excludes node_modules, .vite, dist, build, .env*, etc., so the context stays clean.

# Repository declares engines.node ">=20". Pin to the LTS 20 line (consistent with
# the existing backend image and Railway's earlier Node v20.20.2 / npm 10 build).
FROM node:20 AS builder

WORKDIR /app

# 1) Copy dependency manifests first (maximizes layer cache).
#    npm workspaces require every workspace package.json for a consistent install.
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY shared/package.json shared/package.json
COPY frontend/package.json frontend/package.json
COPY local-agent/package.json local-agent/package.json

# 2) Install ALL workspace dependencies inside the container. The build context
#    (via .dockerignore) never contains node_modules, so every build starts from a
#    clean install.
RUN npm ci

# 3) Copy remaining source/configuration (node_modules & caches excluded by .dockerignore).
COPY . .

# 4) Build the frontend production bundle (vite -> dist/). The frontend has no
#    @codeconclave/* imports, so no sibling workspace dist is required at build or
#    runtime here.
RUN npm run build --workspace @codeconclave/frontend

# ---- Runtime ----
FROM node:20 AS runtime

ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app

# server.cjs uses only Node core modules (http/https/fs/path), so no node_modules is
# required at runtime. Only the static bundle and the server entrypoint are needed.
COPY frontend/server.cjs frontend/server.cjs
COPY --from=builder /app/frontend/dist frontend/dist

# The app reads PORT from the environment (default 8080 set above / Railway injects
# PORT). Serves the SPA from dist/ and proxies /api/* and /health(/) to the backend
# (FRONTEND_PROXY_TARGET, Railway env).
EXPOSE 8080

CMD ["node", "frontend/server.cjs"]
