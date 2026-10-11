# syntax=docker/dockerfile:1.6
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --cache /tmp/our-days-npm-cache --no-audit --no-fund \
    && rm -rf /tmp/our-days-npm-cache

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS=--max-old-space-size=768
RUN npm run build

FROM deps AS worker
ENV NODE_ENV=production
RUN groupadd -g 10001 ourdays && useradd -u 10001 -g ourdays ourdays
COPY scripts ./scripts
COPY src/lib ./src/lib
COPY db ./db
USER 10001:10001
CMD ["node_modules/.bin/tsx", "scripts/tick.ts"]

FROM node:22-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
RUN groupadd -g 10001 ourdays && useradd -u 10001 -g ourdays ourdays
COPY --from=build --chown=10001:10001 /app/.next/standalone ./
COPY --from=build --chown=10001:10001 /app/.next/static ./.next/static
USER 10001:10001
EXPOSE 3000
CMD ["node", "server.js"]
