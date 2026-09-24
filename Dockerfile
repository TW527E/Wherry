# ARM64 (aarch64) friendly image for Oracle Cloud / Debian hosts.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    CHROMIUM_PATH=/usr/bin/chromium
# The X collector reads with a local browser; chromium is installed by default and
# a host Chrome can be selected instead via X_BROWSER on non-container deployments.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 bridge
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /app/data && chown -R bridge:bridge /app
USER bridge
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=10s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/cli.js", "serve"]
