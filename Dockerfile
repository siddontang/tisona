FROM rust:1.99-slim-bookworm AS engine
RUN apt-get update && apt-get install -y --no-install-recommends git python3 ca-certificates pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY engine-source.json ./
COPY scripts/fetch-engine.py ./
RUN python3 fetch-engine.py
WORKDIR /build/resonate/impl/server/core
RUN cargo build --locked --release --bin resonate

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=engine /build/resonate/impl/server/core/target/release/resonate /usr/local/bin/resonate
COPY --chown=node:node . .
USER node
ENV NODE_ENV=production RESONATE_STATE_DIR=/tmp/tisona RESONATE_ENGINE_BINARY=/usr/local/bin/resonate
EXPOSE 8787
ENTRYPOINT ["node", "deploy/cloudflare/entrypoint.mjs"]
