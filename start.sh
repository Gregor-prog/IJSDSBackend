#!/bin/sh
set -e

# Clear the failed record of this migration if a previous attempt errored
# (the failed run was rolled back in a transaction, so nothing was applied).
# No-op when the migration isn't in a failed state.
npx prisma migrate resolve --rolled-back 20260701000000_add_missing_article_columns 2>/dev/null || true

echo "[startup] Running database migrations..."
npx prisma migrate deploy
echo "[startup] Migrations complete."

# Safety net: migrate deploy skips any migration already recorded as applied,
# even if its columns were never actually created (e.g. a partial run that was
# later resolved as applied). This SQL is idempotent (ADD COLUMN IF NOT EXISTS),
# so running it on every boot reconciles the schema with the database.
echo "[startup] Ensuring article columns exist..."
npx prisma db execute \
  --file prisma/migrations/20260701000000_add_missing_article_columns/migration.sql \
  --schema prisma/schema.prisma
echo "[startup] Column check complete. Starting server..."

exec node server.js
