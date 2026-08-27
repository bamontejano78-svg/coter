#!/usr/bin/env bash
# Coter Pro - Backup/restore drill for release readiness.
#
# Required:
#   SOURCE_DATABASE_URL       Database to dump (usually staging/test).
#   DRILL_ADMIN_DATABASE_URL  Maintenance/admin URL with CREATEDB permission.
#
# The script creates a temporary restore database, restores the backup there,
# runs a small schema sanity check, and drops the database on exit.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

SOURCE_DATABASE_URL="${SOURCE_DATABASE_URL:-${DATABASE_URL:-}}"
DRILL_ADMIN_DATABASE_URL="${DRILL_ADMIN_DATABASE_URL:-}"

if [[ -z "$SOURCE_DATABASE_URL" ]]; then
  echo "ERROR: SOURCE_DATABASE_URL or DATABASE_URL is required" >&2
  exit 1
fi

if [[ -z "$DRILL_ADMIN_DATABASE_URL" ]]; then
  echo "ERROR: DRILL_ADMIN_DATABASE_URL is required and must point to a maintenance DB" >&2
  exit 1
fi

for bin in pg_dump psql createdb dropdb gzip sha256sum node; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "ERROR: required command not found: $bin" >&2
    exit 1
  }
done

RESTORE_DB_NAME="coter_restore_drill_$(date -u +%Y%m%d%H%M%S)_$$"

url_with_database() {
  node -e "
    const u = new URL(process.argv[1]);
    u.pathname = '/' + process.argv[2];
    u.searchParams.delete('options');
    console.log(u.toString());
  " "$1" "$2"
}

RESTORE_DATABASE_URL="$(url_with_database "$DRILL_ADMIN_DATABASE_URL" "$RESTORE_DB_NAME")"
BACKUP_DIR="$(mktemp -d)"

cleanup() {
  set +e
  dropdb --if-exists --maintenance-db="$DRILL_ADMIN_DATABASE_URL" "$RESTORE_DB_NAME" >/dev/null 2>&1
  rm -rf "$BACKUP_DIR"
}
trap cleanup EXIT

echo "Creating temporary restore database: $RESTORE_DB_NAME"
createdb --maintenance-db="$DRILL_ADMIN_DATABASE_URL" "$RESTORE_DB_NAME"

echo "Creating backup from source database..."
ENV_FILE=/dev/null \
  DATABASE_URL="$SOURCE_DATABASE_URL" \
  BACKUP_DIR="$BACKUP_DIR" \
  bash "$SCRIPT_DIR/backup.sh" >/tmp/coter_backup_drill_backup.log

BACKUP_FILE="$(
  find "$BACKUP_DIR" -type f \( -name 'coter_backup_*.sql.gz' -o -name 'coter_backup_*.sql.gz.gpg' \) |
  sort |
  tail -n 1
)"

if [[ -z "$BACKUP_FILE" || ! -s "$BACKUP_FILE" ]]; then
  echo "ERROR: backup file was not created" >&2
  cat /tmp/coter_backup_drill_backup.log >&2 || true
  exit 1
fi

echo "Restoring backup into temporary database..."
RESTORE_DATABASE_URL="$RESTORE_DATABASE_URL" \
  bash "$SCRIPT_DIR/restore-backup.sh" "$BACKUP_FILE" >/tmp/coter_backup_drill_restore.log

echo "Running restore sanity checks..."
TABLE_COUNT="$(
  psql "$RESTORE_DATABASE_URL" --set ON_ERROR_STOP=1 --tuples-only --no-align \
    -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('_migrations', 'therapists', 'patients', 'messages', 'assignments');"
)"

if [[ "${TABLE_COUNT:-0}" -lt 5 ]]; then
  echo "ERROR: restored database is missing expected application tables" >&2
  cat /tmp/coter_backup_drill_restore.log >&2 || true
  exit 1
fi

MIGRATION_COUNT="$(
  psql "$RESTORE_DATABASE_URL" --set ON_ERROR_STOP=1 --tuples-only --no-align \
    -c "SELECT COUNT(*) FROM _migrations;"
)"

if [[ "${MIGRATION_COUNT:-0}" -lt 1 ]]; then
  echo "ERROR: restored database has no migration history" >&2
  exit 1
fi

echo "Backup/restore drill OK: restored $TABLE_COUNT core tables and $MIGRATION_COUNT migrations."
