FROM node:24-bookworm-slim

ARG DEBIAN_MIRROR=http://deb.debian.org

RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
  && apt-get -o Acquire::Retries=5 update \
  && apt-get install -y --no-install-recommends ca-certificates dumb-init git \
  && rm -rf /var/lib/apt/lists/*

ARG CLAUDE_CODE_VERSION=2.1.218
ARG CODEX_VERSION=0.145.0
ARG OPENCLAW_VERSION=2026.7.1-2
ARG HIBRO_BUNDLED_ENGINES=all
ARG NPM_REGISTRY=https://registry.npmjs.org

RUN engines=",${HIBRO_BUNDLED_ENGINES}," \
  && packages="" \
  && if [ "${HIBRO_BUNDLED_ENGINES}" = "all" ] || echo "${engines}" | grep -q ',claude-code,'; then packages="${packages} @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"; fi \
  && if [ "${HIBRO_BUNDLED_ENGINES}" = "all" ] || echo "${engines}" | grep -q ',codex,'; then packages="${packages} @openai/codex@${CODEX_VERSION}"; fi \
  && if [ "${HIBRO_BUNDLED_ENGINES}" = "all" ] || echo "${engines}" | grep -q ',openclaw,'; then packages="${packages} openclaw@${OPENCLAW_VERSION}"; fi \
  && if [ -n "${packages}" ]; then npm install --global --registry="${NPM_REGISTRY}" ${packages}; fi

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry="${NPM_REGISTRY}"

COPY src ./src
COPY scripts/backup-database.ts ./scripts/backup-database.ts
COPY scripts/restore-database.ts ./scripts/restore-database.ts
COPY assets ./assets
COPY README.md VERSION ./
COPY docker-entrypoint.sh /usr/local/bin/hibro-entrypoint

RUN chmod +x /usr/local/bin/hibro-entrypoint \
  && mkdir -p /data /workspace/project /home/node/.codex \
  && chown -R node:node /data /workspace /home/node/.codex /app

ENV NODE_ENV=production \
    HIBRO_NODE_HOST=0.0.0.0 \
    HIBRO_NODE_ALLOW_REMOTE_ACCESS=true \
    HIBRO_NODE_PORT=7331 \
    HIBRO_NODE_DATA_DIR=/data/.hibro \
    HIBRO_DEFAULT_PROJECT_ROOT=/workspace/project \
    HIBRO_IMPORT_SHELL_ENV=false \
    HIBRO_CONTAINER=docker \
    CODEX_HOME=/home/node/.codex

USER node

EXPOSE 7331
VOLUME ["/data"]

ENTRYPOINT ["hibro-entrypoint"]
CMD ["node", "--experimental-strip-types", "src/cli.ts", "serve"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:7331/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
