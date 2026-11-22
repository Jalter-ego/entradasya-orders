# syntax=docker/dockerfile:1

ARG NODE_VERSION=22-alpine

# ---- base: Node + pnpm (misma versión que packageManager en package.json) ----
FROM node:${NODE_VERSION} AS base
ARG PNPM_VERSION=12.11.2
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# ---- build: todas las dependencias + compilación TypeScript ----
FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# ---- prod-deps: solo dependencias de producción ----
FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

# ---- runtime: imagen final mínima, sin pnpm ni código fuente ----
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3003
WORKDIR /app

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 3003

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3003) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# La configuración llega por variables de entorno (no hay .env dentro de la imagen).
CMD ["node", "dist/server.js"]
