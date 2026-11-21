# syntax=docker/dockerfile:1

ARG NODE_VERSION=22-alpine

# --- 1. Full Dependencies --------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- 2. Build Frontend (Vite SPA -> web/dist) ------------------------------
FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- 3. Production Runtime -------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001

RUN apk add --no-cache tini

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy backend application, database migrations, and compiled frontend SPA
COPY backend ./backend
COPY run-migrations.js ./
COPY --from=build /app/web/dist ./web/dist

# Prepare uploads directory with correct permissions
RUN mkdir -p uploads && chown -R node:node /app

USER node
EXPOSE 3001

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "backend/server.js"]
