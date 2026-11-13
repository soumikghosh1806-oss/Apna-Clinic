#!/usr/bin/env bash
# Runs one real-backend browser test script against the TEST ONLY stand-in API, then cleans up.
#
#   bash scripts/run-e2e.sh e2e/supabase_flows.cjs
#   bash scripts/run-e2e.sh e2e/public_booking_flows.cjs
#   bash scripts/run-e2e.sh e2e/schedule_flows.cjs
#   bash scripts/run-e2e.sh e2e/responsive_public.cjs
#
# What it does: builds the app against the stand-in (never your real project), starts the stand-in API (it runs the real
# SQL from supabase/migrations on a throwaway Postgres, plus the real code of the two Edge Functions, with a fake text
# message and email provider), serves the build on port 4174, runs the script, and stops everything.
#
# Needs: Node 22.12 or newer, and once: npm install --no-save playwright axe-core && npx playwright install chromium
# The throwaway Postgres refuses to run as the root user. If you are root (some containers), start the stand-in as another
# user by setting SHIM_RUNNER, for example:  SHIM_RUNNER="runuser -u claude --" bash scripts/run-e2e.sh e2e/schedule_flows.cjs

set -u
if [ "$#" -lt 1 ]; then echo "usage: bash scripts/run-e2e.sh e2e/<script>.cjs" >&2; exit 2; fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
SHIM_RUNNER="${SHIM_RUNNER:-}"
SHIM_PORT="${SHIM_PORT:-54399}"
APP_PORT=4174
DIST="${TMPDIR:-/tmp}/cliniq-e2e-dist"

stop_all() {
  pkill -f "api-shim.mjs" 2>/dev/null
  pkill -f "vite preview --outDir ${DIST}" 2>/dev/null
  pkill -f "cliniq-pgdata" 2>/dev/null
}
trap stop_all EXIT
stop_all
sleep 1

if [ -n "$SHIM_RUNNER" ]; then chmod -R a+rX "$ROOT/supabase" "$ROOT/src" 2>/dev/null; fi

VITE_BACKEND=supabase VITE_SUPABASE_URL="http://127.0.0.1:${SHIM_PORT}" \
  VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_localshim_000000000000000000 \
  npx vite build --outDir "$DIST" > "${TMPDIR:-/tmp}/e2e-build.txt" 2>&1 || { tail -20 "${TMPDIR:-/tmp}/e2e-build.txt"; exit 1; }

( cd supabase/tests/e2e && $SHIM_RUNNER node api-shim.mjs > "${TMPDIR:-/tmp}/shim.log" 2>&1 & )
( npx vite preview --outDir "$DIST" --port "$APP_PORT" > "${TMPDIR:-/tmp}/preview.log" 2>&1 & )

ready=0
for _ in $(seq 1 90); do
  if curl -s "http://127.0.0.1:${SHIM_PORT}/__shim/outbox" > /dev/null 2>&1 && curl -s "http://127.0.0.1:${APP_PORT}/" > /dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != "1" ]; then echo "The stand-in API or the app did not start. See ${TMPDIR:-/tmp}/shim.log and ${TMPDIR:-/tmp}/preview.log" >&2; exit 1; fi

node "$@"
