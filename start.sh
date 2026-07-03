#!/bin/sh
set -e
echo "[startup] Running database migrations..."
npx prisma migrate deploy
echo "[startup] Migrations complete. Starting server..."
exec node server.js
