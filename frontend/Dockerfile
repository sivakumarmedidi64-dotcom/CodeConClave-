# CodeConClave Frontend — Production Dockerfile
# Multi-stage: Vite build → Nginx static serve

# ---- Build Stage ----
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files for cache
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY shared/tsconfig.json shared/tsconfig.json
COPY frontend/package.json frontend/package.json
COPY frontend/tsconfig.json frontend/tsconfig.json
COPY frontend/vite.config.ts frontend/vite.config.ts
COPY frontend/index.html frontend/index.html

# Install all deps
RUN npm ci --workspaces --include-workspace-root

# Copy source
COPY shared/src ./shared/src
COPY frontend/src ./frontend/src
COPY frontend/index.html frontend/index.html

# Build shared first, then frontend
RUN npm run build --workspace @codeconclave/shared
RUN npm run build --workspace @codeconclave/frontend

# ---- Runner Stage ----
FROM nginx:alpine AS runner

# Copy built assets
COPY --from=builder /app/frontend/dist /usr/share/nginx/html

# Copy nginx config
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]