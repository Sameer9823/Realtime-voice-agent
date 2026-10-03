# syntax=docker/dockerfile:1

# Multi-stage build. The runtime image carries only the standalone server output, its traced
# dependencies, and the static assets — not the source, not the full node_modules, and not the
# toolchain. The package is marked private and ships no build step of its own, so there is nothing
# to compile here beyond `next build`.

ARG NODE_VERSION=22-alpine

# ─── deps ──────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

# Only the manifests, so this layer is cached until a dependency actually changes. `npm ci` fails
# rather than silently updating the lockfile, which is what keeps the image reproducible.
COPY package.json package-lock.json ./
RUN npm ci

# ─── build ─────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `NEXT_TELEMETRY_DISABLED` because a container build should not phone home.
ENV NEXT_TELEMETRY_DISABLED=1
# Baked into the bundle at build time, so the browser can be told the session cap. The OpenAI key
# is deliberately not here: it is read at runtime by the server, and never by the client.
ARG NEXT_PUBLIC_MAX_SESSION_MINUTES
ENV NEXT_PUBLIC_MAX_SESSION_MINUTES=${NEXT_PUBLIC_MAX_SESSION_MINUTES}

RUN npm run build

# ─── runtime ───────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# `next build` with `output: "standalone"` traces the imports of the server bundle and writes a
# minimal package.json alongside it. Copying the directory preserves that.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public
# The documentation tool reads this at request time with a plain filesystem call, so Next's
# dependency tracing does not pick it up and it has to be copied explicitly.
COPY --from=build --chown=nextjs:nodejs /app/content ./content

# Unprivileged by default. The node image ships a `node` user; remapping it to `nextjs` keeps the
# familiar name without assuming the uid that came with the base image.
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
USER nextjs

EXPOSE 3000

# Checks the real liveness endpoint, which is the same one a deploy platform would poll.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]