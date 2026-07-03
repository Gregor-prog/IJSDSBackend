#!/bin/sh
set -e

# Clear the failed record of this migration if a previous attempt errored
# (the failed run was rolled back in a transaction, so nothing was applied).
# No-op when the migration isn't in a failed state.
npx prisma migrate resolve --rolled-back 20260701000000_add_missing_article_columns 2>/dev/null || true

echo "[startup] Running database migrations..."
npx prisma migrate deploy
echo "[startup] Migrations complete. Starting server..."
exec node server.js
