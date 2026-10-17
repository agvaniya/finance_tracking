# ---- caddy: build the TLS terminator with the Route 53 DNS plugin ----
# The stock Caddy binary has no Route 53 module, and the DNS-01 ACME challenge
# needs one. DNS-01 is used rather than HTTP-01 because the task's public IP
# (and therefore its A record) changes on every replacement, so an inbound
# HTTP challenge would race the DNS update.
FROM caddy:2-builder-alpine AS caddy-builder
RUN xcaddy build --with github.com/caddy-dns/route53

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
# Placeholder URL: the build only needs a parseable value, never a connection.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build?schema=public"
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate && npm run build

# ---- runner: minimal runtime image ----
FROM node:22-alpine AS runner
RUN apk add --no-cache openssl ca-certificates libcap bash
WORKDIR /app
# DATABASE_URL and SESSION_SECRET are injected at runtime
# (compose env, or SSM Parameter Store on Fargate).
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    XDG_DATA_HOME=/data \
    XDG_CONFIG_HOME=/data/config

# Fixed uid so the EFS access point can be configured to match it.
RUN addgroup -S -g 10001 app && adduser -S -u 10001 -G app app

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

# Fargate cannot grant extra Linux capabilities to a task, but NET_BIND_SERVICE
# is already in the default container capability bounding set — a file
# capability on the binary is therefore enough for a non-root Caddy to bind
# ports 80 and 443.
COPY --from=caddy-builder /usr/bin/caddy /usr/bin/caddy
RUN setcap cap_net_bind_service=+ep /usr/bin/caddy \
    && mkdir -p /data/config \
    && chown -R app:app /data

COPY --chown=app:app docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh

USER app
EXPOSE 80 443 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
