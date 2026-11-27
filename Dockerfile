# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22.23.4-alpine
ARG ALPINE_MIRROR=dl-cdn.alpinelinux.org
ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG APP_VERSION=unknown

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS nativebase
ARG ALPINE_MIRROR
WORKDIR /app

# Use the official Alpine mirror by default. A repository variable/build arg can
# override it for environments that require a regional mirror.
RUN if [ "$ALPINE_MIRROR" != "dl-cdn.alpinelinux.org" ]; then \
      sed -i "s|dl-cdn.alpinelinux.org|${ALPINE_MIRROR}|g" /etc/apk/repositories; \
    fi

FROM nativebase AS builder
ARG NPM_REGISTRY

RUN apk add --no-cache python3 make g++ linux-headers

COPY package.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm install \
      --registry="${NPM_REGISTRY}" \
      --fetch-retries=5 \
      --fetch-retry-factor=2 \
      --fetch-retry-mintimeout=10000 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=300000

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS=--max-old-space-size=3072
RUN CIRCLE_NODE_TOTAL=2 npm run build && rm -rf /app/.next/standalone/node_modules

FROM ${NODE_IMAGE} AS base
ARG ALPINE_MIRROR
WORKDIR /app

# Use the official Alpine mirror by default. A repository variable/build arg can
# override it for environments that require a regional mirror.
RUN if [ "$ALPINE_MIRROR" != "dl-cdn.alpinelinux.org" ]; then \
      sed -i "s|dl-cdn.alpinelinux.org|${ALPINE_MIRROR}|g" /etc/apk/repositories; \
    fi

FROM base AS targetdeps
ARG NPM_REGISTRY

RUN apk add --no-cache python3 make g++ linux-headers

COPY package.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm install \
      --registry="${NPM_REGISTRY}" \
      --fetch-retries=5 \
      --fetch-retry-factor=2 \
      --fetch-retry-mintimeout=10000 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=300000

RUN --mount=type=cache,target=/root/.npm npm prune --omit=dev --ignore-scripts --offline
# https://github.com/decolua/9router/issues/5245
# wreq-js and playwright-core are lazy runtime dependencies (loaded by
# lazyRuntime.js via createRequire). Next standalone tracing does not include
# them, so OpenCode Free fails with HTTP 502 ("resolve is undefined").
# Install them (with their native bindings/transitive deps) in an isolated dir
# so the runner stage can copy them into /app/node_modules.
RUN --mount=type=cache,target=/root/.npm \
    mkdir -p /opt/lazy-runtime && cd /opt/lazy-runtime && \
    npm init -y >/dev/null && \
    npm install --no-save \
      --registry="${NPM_REGISTRY}" \
      --fetch-retries=5 \
      --fetch-retry-factor=2 \
      --fetch-retry-mintimeout=10000 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=300000 \
      wreq-js playwright-core

FROM ${NODE_IMAGE} AS runner
ARG ALPINE_MIRROR
ARG APP_VERSION
WORKDIR /app

RUN if [ "$ALPINE_MIRROR" != "dl-cdn.alpinelinux.org" ]; then \
      sed -i "s|dl-cdn.alpinelinux.org|${ALPINE_MIRROR}|g" /etc/apk/repositories; \
    fi

LABEL org.opencontainers.image.title="9router" \
      org.opencontainers.image.version="${APP_VERSION}"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data

COPY --from=builder /app/LICENSE /app/LICENSE
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/custom-server.js ./custom-server.js
COPY --from=builder /app/open-sse ./open-sse
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --from=builder /app/src/mitm ./src/mitm
RUN mkdir -p /app/data && chown -R node:node /app && \
  mkdir -p /app/data-home && chown node:node /app/data-home && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true

# Avoid a full distribution upgrade in the runtime image. It makes builds less
# reproducible and is unrelated to installing the runtime entrypoint helper.
RUN apk add --no-cache su-exec ffmpeg && \
  printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null\nexec su-exec node "$@"\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh

COPY --from=targetdeps --chown=node:node /app/node_modules ./node_modules
COPY --from=targetdeps --chown=node:node /opt/lazy-runtime/node_modules/. ./node_modules/

RUN test -s /app/.next/server/app/api/v1/ocr/route.js

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]
