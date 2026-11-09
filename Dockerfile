# syntax=docker/dockerfile:1

FROM oven/bun:1.3.4 AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run db:generate
RUN bun run build

FROM oven/bun:1.3.4 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DATABASE_URL=file:/app/data/panel.db

# Prisma CLI is needed at first boot to apply the checked-in schema to the
# persistent SQLite volume. Keep the generated client and matching engines.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY deploy/docker-entrypoint.sh ./deploy/docker-entrypoint.sh

RUN mkdir -p /app/data && chmod +x /app/deploy/docker-entrypoint.sh

EXPOSE 3000
VOLUME ["/app/data"]

ENTRYPOINT ["/app/deploy/docker-entrypoint.sh"]
