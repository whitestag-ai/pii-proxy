# syntax=docker/dockerfile:1.7

# ---- Builder ----
FROM node:22-bookworm-slim AS builder
WORKDIR /workspace

# Enable pnpm via corepack
RUN corepack enable

# Native build deps for better-sqlite3 and keytar
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 build-essential \
      && rm -rf /var/lib/apt/lists/*

# Copy monorepo root metadata for workspace resolution
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/server/package.json ./packages/server/

# Install all workspace deps
RUN pnpm install --frozen-lockfile

# Copy sources
COPY packages/core ./packages/core
COPY packages/server ./packages/server

# Build
RUN pnpm -r build

# ---- Runtime ----
FROM node:22-bookworm-slim AS runtime

# keytar has native deps; we avoid keytar in Docker by setting a mapping key directly
# via env var instead. See docs/CONFIG.md.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      libsecret-1-0 \
      && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy server artefacts and its node_modules first (includes a workspace-symlink
# for @whitestag/pii-proxy-core that we replace with the real core package below).
COPY --from=builder /workspace/packages/server/dist ./dist
COPY --from=builder /workspace/packages/server/package.json ./
COPY --from=builder /workspace/packages/server/node_modules ./node_modules

# Drop the workspace-symlink for core and copy the real package contents in.
RUN rm -rf ./node_modules/@whitestag/pii-proxy-core \
    && mkdir -p ./node_modules/@whitestag/pii-proxy-core
COPY --from=builder /workspace/packages/core/dist ./node_modules/@whitestag/pii-proxy-core/dist
COPY --from=builder /workspace/packages/core/package.json ./node_modules/@whitestag/pii-proxy-core/
COPY --from=builder /workspace/packages/core/pii-proxy-rules.default.yaml ./node_modules/@whitestag/pii-proxy-core/

# Non-root user
RUN useradd --system --uid 1001 pii-proxy \
    && mkdir -p /var/lib/pii-proxy/audit \
    && chown -R pii-proxy:pii-proxy /var/lib/pii-proxy

USER pii-proxy
ENV NODE_ENV=production
ENV PII_PROXY_BIND=0.0.0.0
ENV PII_PROXY_PORT=4711
ENV PII_PROXY_MAPPING_DB=/var/lib/pii-proxy/mappings.db
ENV PII_PROXY_AUDIT_DIR=/var/lib/pii-proxy/audit

EXPOSE 4711
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:4711/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
