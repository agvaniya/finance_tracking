# ---- deps: install node_modules (includes prisma generate via postinstall) ----
FROM node:22-alpine AS deps
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN npm ci

# ---- builder: compile the Next.js standalone bundle ----
FROM node:22-alpine AS builder
RUN apk add --no-cache openssl
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV DATABASE_URL="file:/app/data/app.db"
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate && npm run build

# ---- runner: minimal runtime image ----
FROM node:22-alpine AS runner
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL="file:/app/data/app.db" \
    HOSTNAME=0.0.0.0 \
    PORT=3000

RUN addgroup -S app && adduser -S app -G app

COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static
COPY --from=builder --chown=app:app /app/public ./public
# Prisma schema + migrations, generated client/engines, and a self-contained
# CLI install (own prefix, full dependency tree) for `migrate deploy` on boot.
COPY --from=builder --chown=app:app /app/prisma/schema.prisma ./prisma/schema.prisma
COPY --from=builder --chown=app:app /app/prisma/migrations ./prisma/migrations
COPY --from=builder --chown=app:app /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=app:app /app/node_modules/.prisma ./node_modules/.prisma
RUN npm install --prefix /app/cli prisma@6 --no-package-lock --loglevel=error \
    && chown -R app:app /app/cli
COPY --chown=app:app docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh && mkdir -p /app/data && chown app:app /app/data

USER app
EXPOSE 3000
VOLUME ["/app/data"]
ENTRYPOINT ["./docker-entrypoint.sh"]
