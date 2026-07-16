#!/bin/sh
set -e

# Clear the failed record of this migration if a previous attempt errored
# (the failed run was rolled back in a transaction, so nothing was applied).
# No-op when the migration isn't in a failed state.
npx prisma migrate resolve --rolled-back 20260701000000_add_missing_article_columns 2>/dev/null || true

echo "[startup] Running database migrations..."
npx prisma migrate deploy
echo "[startup] Migrations complete."

# Reconcile any schema drift the migration history missed. `db push` (WITHOUT
# --accept-data-loss) adds every column/table the schema declares but the DB is
# missing — this is what repeatedly 500'd on unmigrated columns. It deliberately
# omits --accept-data-loss so a destructive diff aborts loudly instead of
# dropping production data on an unattended boot. Guarded so it never blocks
# startup.
echo "[startup] Reconciling schema drift (additive)..."
npx prisma db push --skip-generate || echo "[startup] db push skipped/failed — continuing"

# Belt-and-suspenders: guarantees the known-critical article columns exist even
# if db push was skipped above. Purely additive and idempotent.
echo "[startup] Ensuring article columns exist..."
node scripts/ensure-columns.js || true

echo "[startup] Starting server..."
exec node server.js
