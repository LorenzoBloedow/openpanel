#!/usr/bin/env bash
# Starts a local Postgres for development and tests.
#
# Production runs on Neon; locally both connection routes (Hyperdrive's
# localConnectionString and the direct DATABASE_URL) point at this cluster.
#
# Uses the Debian/Ubuntu cluster tooling when available (pg_ctlcluster), and
# falls back to `docker compose up op-db` otherwise.
set -euo pipefail

PGVERSION="${PGVERSION:-16}"
PGPORT="${PGPORT:-5432}"
PGPASSWORD_LOCAL="${PGPASSWORD_LOCAL:-postgres}"

if command -v pg_ctlcluster >/dev/null 2>&1; then
  if ! pg_lsclusters | awk '{print $1" "$2" "$4}' | grep -q "^${PGVERSION} main online"; then
    pg_ctlcluster "${PGVERSION}" main start
  fi
  if [ "$(id -u)" = "0" ]; then
    su postgres -c "psql -q -c \"ALTER USER postgres PASSWORD '${PGPASSWORD_LOCAL}';\""
  else
    psql -q -U postgres -c "ALTER USER postgres PASSWORD '${PGPASSWORD_LOCAL}';"
  fi
elif command -v docker >/dev/null 2>&1; then
  docker compose up -d --wait op-db
else
  echo "Neither pg_ctlcluster nor docker is available; start Postgres ${PGVERSION} manually." >&2
  exit 1
fi

echo "Postgres ready: postgresql://postgres:${PGPASSWORD_LOCAL}@localhost:${PGPORT}/postgres"
