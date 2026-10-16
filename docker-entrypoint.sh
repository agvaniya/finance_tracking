#!/usr/bin/env bash
#
# Boot order: apply migrations, start Next.js, and — when TLS is terminated in
# this container — start Caddy in front of it. Without CADDY_ENABLED the app
# serves plain HTTP itself, which is what compose and the no-domain AWS mode do.

set -euo pipefail

PRISMA="node /app/cli/node_modules/prisma/build/index.js"

# The database may still be accepting connections slowly (a fresh RDS instance,
# or Postgres starting next to us in compose), so retry before giving up.
attempt=1
max_attempts="${MIGRATE_MAX_ATTEMPTS:-10}"
until $PRISMA migrate deploy --schema prisma/schema.prisma; do
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "migrate deploy failed after ${attempt} attempts; giving up." >&2
    exit 1
  fi
  echo "migrate deploy failed (attempt ${attempt}/${max_attempts}); retrying in 5s..." >&2
  attempt=$((attempt + 1))
  sleep 5
done

if [ "${CADDY_ENABLED:-false}" != "true" ]; then
  exec node server.js
fi

# ---------------------------------------------------------------------------
# TLS mode: Caddy owns 80/443, Next.js is reachable only over the loopback.
# ---------------------------------------------------------------------------

: "${DOMAIN_NAME:?CADDY_ENABLED=true requires DOMAIN_NAME}"
: "${ACME_EMAIL:?CADDY_ENABLED=true requires ACME_EMAIL}"

export HOSTNAME=127.0.0.1

CADDYFILE=/data/config/Caddyfile
mkdir -p "$(dirname "$CADDYFILE")"

# Let's Encrypt allows only 5 identical certificates per week. Point
# ACME_STAGING at the staging CA while iterating so a few rebuilds cannot
# exhaust the real quota and lock the domain out for days.
acme_ca_line=""
if [ "${ACME_STAGING:-false}" = "true" ]; then
  acme_ca_line="acme_ca https://acme-staging-v02.api.letsencrypt.org/directory"
  echo "Caddy: using the Let's Encrypt STAGING CA — browsers will not trust this certificate." >&2
fi

cat > "$CADDYFILE" <<EOF
{
	email ${ACME_EMAIL}
	admin off
	${acme_ca_line}
}

${DOMAIN_NAME} {
	encode gzip
	reverse_proxy 127.0.0.1:${PORT:-3000}

	tls {
		dns route53 {
			max_retries 10
		}
		resolvers 1.1.1.1 8.8.8.8
	}
}
EOF

caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null

node server.js &
node_pid=$!

caddy run --config "$CADDYFILE" --adapter caddyfile &
caddy_pid=$!

# If either process dies the container should die with it, so ECS replaces the
# task rather than leaving a half-serving container behind.
terminate() {
  trap - TERM INT
  kill "$node_pid" "$caddy_pid" 2>/dev/null || true
  wait "$node_pid" "$caddy_pid" 2>/dev/null || true
}
trap terminate TERM INT

wait -n "$node_pid" "$caddy_pid"
status=$?
echo "A supervised process exited (status ${status}); shutting the container down." >&2
terminate
exit "$status"
