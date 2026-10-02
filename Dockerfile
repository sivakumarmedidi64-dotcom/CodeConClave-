# CodeConClave backend — production Docker image.
# Reconstructed from the verified current repository (workspaces: backend, shared,
# frontend, local-agent; engines.node ">=20"; npm workspaces via package-lock.json).
# Deployment/build-system only. No application source changes.
# No secrets are baked into the image; all runtime config comes from Railway env.

# Repository declares engines.node ">=20". Pin to the LTS 20 line (earlier Railway
# build used Node v20.20.2 / npm 10) for a consistent runtime.
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
#    clean install — the frontend/node_modules/.vite EBUSY failure class cannot occur.
RUN npm ci

# 3) Copy remaining source/configuration (node_modules & caches excluded by .dockerignore).
COPY . .

# 4) Build shared first (backend depends on its dist), then backend, then the
#    frontend SPA bundle so the backend can host the website and API on ONE
#    production origin (the backend's spaMiddleware serves frontend/dist).
RUN npm run build --workspace @codeconclave/shared \
 && npm run build --workspace @codeconclave/backend \
 && npm run build --workspace @codeconclave/frontend

# ---- Runtime ----
FROM node:20 AS runtime

ENV NODE_ENV=production
ENV PORT=4000
WORKDIR /app

# Workspace manifests + lockfile so package resolution is consistent at runtime.
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY shared/package.json shared/package.json
COPY frontend/package.json frontend/package.json
COPY local-agent/package.json local-agent/package.json

# Built artifacts (backend + shared dist) and the installed dependencies.
# Only backend and shared are compiled; the frontend SPA bundle is copied as a
# static payload served by backend/src/static/spa.ts (single-origin website+API).
COPY --from=builder /app/backend/dist backend/dist
COPY --from=builder /app/shared/dist shared/dist
COPY --from=builder /app/frontend/dist frontend/dist
COPY --from=builder /app/node_modules node_modules

# The application reads PORT from the environment (default 4000 set above /
# Railway injects PORT). /healthz and /health are served by the app.
EXPOSE 4000

# Start the existing backend (equivalent to: npm run start --workspace @codeconclave/backend)
CMD ["node", "backend/dist/server.js"]
