#!/bin/sh
set -e

# Apply any pending migrations against the configured database, then start.
node /app/cli/node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma

exec node server.js
