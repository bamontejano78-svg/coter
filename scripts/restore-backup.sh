#!/usr/bin/env bash
# Coter Pro — Restauración controlada de backup
# Nunca apunta a producción por defecto: requiere RESTORE_DATABASE_URL.
set -euo pipefail

BACKUP_FILE="${1:-}"
if [[ -z "$BACKUP_FILE" || ! -r "$BACKUP_FILE" ]]; then
  echo "Uso: RESTORE_DATABASE_URL=postgresql://... bash scripts/restore-backup.sh backup.sql.gz[.gpg]" >&2
  exit 1
fi

: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL es obligatorio y debe apuntar a una BD aislada}"
if [[ "${RESTORE_DATABASE_URL}" == *"coter.app"* || "${RESTORE_DATABASE_URL}" == *"production"* ]]; then
  echo "ERROR: RESTORE_DATABASE_URL parece apuntar a producción; usa una base aislada" >&2
  exit 1
fi

if [[ -n "${BACKUP_ENCRYPTION_KEY_FILE:-}" && "$BACKUP_FILE" == *.gpg ]]; then
  TMP_FILE="$(mktemp --suffix=.sql.gz)"
  trap 'rm -f "$TMP_FILE"' EXIT
  gpg --batch --decrypt --passphrase-file "$BACKUP_ENCRYPTION_KEY_FILE" \
    --output "$TMP_FILE" "$BACKUP_FILE"
  INPUT_FILE="$TMP_FILE"
else
  INPUT_FILE="$BACKUP_FILE"
fi

if [[ -f "$BACKUP_FILE.sha256" ]]; then
  sha256sum --check "$BACKUP_FILE.sha256"
fi

echo "Restaurando en la base indicada por RESTORE_DATABASE_URL..."
gunzip -c "$INPUT_FILE" | psql "$RESTORE_DATABASE_URL" --set ON_ERROR_STOP=1
psql "$RESTORE_DATABASE_URL" --set ON_ERROR_STOP=1 -c 'SELECT 1;'
echo "Restauración completada y verificada."
