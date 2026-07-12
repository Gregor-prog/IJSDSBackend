#!/bin/sh
set -e

# Clear the failed record of this migration if a previous attempt errored
# (the failed run was rolled back in a transaction, so nothing was applied).
# No-op when the migration isn't in a failed state.
npx prisma migrate resolve --rolled-back 20260701000000_add_missing_article_columns 2>/dev/null || true

echo "[startup] Running database migrations..."
npx prisma migrate deploy
echo "[startup] Migrations complete."

# Safety net: migrate deploy skips migrations already recorded as applied, even
# when their columns were never created. This reconciles the articles table
# directly. Idempotent, and must never prevent the server from starting.
echo "[startup] Ensuring article columns exist..."
node scripts/ensure-columns.js || true

echo "[startup] Starting server..."
exec node server.js
