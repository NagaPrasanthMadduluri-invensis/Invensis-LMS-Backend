#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"   # repo root, wherever it's checked out

sudo -u ubuntu -H git pull origin main   # ubuntu owns the GitHub deploy key
npm install                              # devDeps incl. drizzle-kit (needed for migrate/generate)

# ── Guard 1: schema drift ───────────────────────────────────────────
# A committed schema change must ship with its migration. If db:generate would
# produce one, a migration is missing/uncommitted. Abort before touching the DB.
echo "→ checking for schema drift…"
GEN_OUT=$(npm run db:generate 2>&1) || true
if ! grep -q "No schema changes" <<<"$GEN_OUT"; then
  echo "❌ SCHEMA DRIFT — schema.js has changes with no matching committed migration. Aborting."
  echo "$GEN_OUT" | tail -8
  exit 1
fi
echo "✓ schema in sync"

# ── Guard 2: un-ledgered DB objects ─────────────────────────────────
# Catch objects created out-of-band (e.g. a 'drizzle-kit push' against the
# shared DB): for each UNAPPLIED migration, the tables/types it CREATEs must
# NOT already exist. Prevents the confusing mid-migrate "already exists" crash.
echo "→ checking for un-ledgered DB objects…"
DBURL=$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-)
MAX_APPLIED=$(psql "$DBURL" -tAc "SELECT COALESCE(MAX(created_at),0) FROM drizzle.__drizzle_migrations" 2>/dev/null || echo 0)
UNAPPLIED=$(node -e "const j=require('./drizzle/meta/_journal.json');const m=Number(process.argv[1]||0);process.stdout.write(j.entries.filter(e=>e.when>m).map(e=>e.tag).join('\n'))" "$MAX_APPLIED")
DRIFT=""
if [ -n "$UNAPPLIED" ]; then
  while IFS= read -r tag; do
    [ -z "$tag" ] && continue
    f="drizzle/${tag}.sql"; [ -f "$f" ] || continue
    while IFS= read -r obj; do
      [ -z "$obj" ] && continue
      exists=$(psql "$DBURL" -tAc "SELECT (to_regclass('public.\"$obj\"') IS NOT NULL) OR EXISTS(SELECT 1 FROM pg_type WHERE typname='$obj')" 2>/dev/null || echo f)
      [ "$exists" = "t" ] && DRIFT+="  - $obj (from ${tag}.sql)"$'\n'
    done < <(grep -oE 'CREATE TABLE "[^"]+"|CREATE TYPE "[^"]+"' "$f" | sed -E 's/.*"([^"]+)".*/\1/')
  done <<< "$UNAPPLIED"
fi
if [ -n "$DRIFT" ]; then
  echo "❌ UN-LEDGERED OBJECTS — these exist in the DB but their migration is unapplied:"
  printf '%s' "$DRIFT"
  echo "   Likely a 'drizzle-kit push' against this DB. Drop the objects (or reconcile the ledger) before migrating."
  exit 1
fi
echo "✓ no un-ledgered objects"

npm run db:migrate                       # applies pending migrations

# Clean single-instance restart — kills the two-daemon / orphan port conflict
pm2 delete learning_portal_api 2>/dev/null || true
sudo -u ubuntu pm2 delete learning_portal_api 2>/dev/null || true
sudo fuser -k 5000/tcp 2>/dev/null || true
pm2 start src/index.js --name learning_portal_api --update-env
pm2 save

sleep 3
pm2 logs learning_portal_api --lines 15 --nostream                          # snapshot, doesn't block
curl -s -o /dev/null -w 'health:%{http_code}\n' localhost:5000/api/health   # expect health:200
