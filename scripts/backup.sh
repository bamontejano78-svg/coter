#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Coter Pro — Backup de PostgreSQL
#
# Uso:
#   bash scripts/backup.sh
#   bash scripts/backup.sh s3
#
# En producción la BD vive en el contenedor postgres. También se puede
# usar DATABASE_URL para desarrollo o proveedores externos.
# Para cifrar backups: BACKUP_ENCRYPTION_KEY_FILE=/ruta/clave.gpg
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_DIR/docker-compose.yml}"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
TIMESTAMP="$(date -u +"%Y%m%d_%H%M%S")"
RAW_FILE="$BACKUP_DIR/coter_backup_$TIMESTAMP.sql.gz"
BACKUP_FILE="$RAW_FILE"
ERR_FILE="$(mktemp)"
trap 'rm -f "$ERR_FILE"' EXIT

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

mkdir -p "$BACKUP_DIR"

if [[ -n "${BACKUP_ENCRYPTION_KEY_FILE:-}" ]]; then
  if [[ ! -r "$BACKUP_ENCRYPTION_KEY_FILE" ]]; then
    echo "ERROR: BACKUP_ENCRYPTION_KEY_FILE no es legible" >&2
    exit 1
  fi
  BACKUP_FILE="$RAW_FILE.gpg"
fi

if [[ "${NODE_ENV:-development}" == "production" && -z "${BACKUP_ENCRYPTION_KEY_FILE:-}" ]]; then
  echo "ERROR: en producción se requiere BACKUP_ENCRYPTION_KEY_FILE" >&2
  exit 1
fi

if [[ "${NODE_ENV:-development}" == "production" ]]; then
  command -v docker >/dev/null 2>&1 || { echo "ERROR: Docker es obligatorio en producción" >&2; exit 1; }
  echo "Realizando pg_dump desde el servicio postgres de producción..."
  sudo docker compose -f "$COMPOSE_FILE" exec -T postgres \
    pg_dump -U coter -d coter --no-owner --no-acl 2>"$ERR_FILE" | gzip > "$RAW_FILE"
elif [[ -n "${DATABASE_URL:-}" ]]; then
  echo "Realizando pg_dump mediante DATABASE_URL..."
  pg_dump "$DATABASE_URL" --no-owner --no-acl 2>"$ERR_FILE" | gzip > "$RAW_FILE"
elif command -v docker >/dev/null 2>&1; then
  echo "Realizando pg_dump desde el servicio postgres..."
  sudo docker compose -f "$COMPOSE_FILE" exec -T postgres \
    pg_dump -U coter -d coter --no-owner --no-acl 2>"$ERR_FILE" | gzip > "$RAW_FILE"
else
  echo "ERROR: define DATABASE_URL o instala Docker" >&2
  exit 1
fi

if [[ ! -s "$RAW_FILE" ]]; then
  echo "ERROR: el backup está vacío" >&2
  cat "$ERR_FILE" >&2 || true
  exit 1
fi

if [[ -n "${BACKUP_ENCRYPTION_KEY_FILE:-}" ]]; then
  gpg --batch --yes --symmetric --cipher-algo AES256 \
    --passphrase-file "$BACKUP_ENCRYPTION_KEY_FILE" \
    --output "$BACKUP_FILE" "$RAW_FILE"
  rm -f "$RAW_FILE"
fi

sha256sum "$BACKUP_FILE" > "$BACKUP_FILE.sha256"

echo "Backup creado: $BACKUP_FILE"
echo "Checksum: $BACKUP_FILE.sha256"

if [[ "${1:-}" == "s3" ]]; then
  S3_BUCKET="${S3_BACKUP_BUCKET:-}"
  if [[ -z "$S3_BUCKET" ]]; then
    echo "ERROR: S3_BACKUP_BUCKET es obligatorio cuando se usa el argumento s3" >&2
    exit 1
  fi
  command -v aws >/dev/null 2>&1 || { echo "ERROR: AWS CLI no está instalado" >&2; exit 1; }
  aws s3 cp "$BACKUP_FILE" "s3://$S3_BUCKET/$(basename "$BACKUP_FILE")" --storage-class STANDARD_IA
  aws s3 cp "$BACKUP_FILE.sha256" "s3://$S3_BUCKET/$(basename "$BACKUP_FILE.sha256")" --storage-class STANDARD_IA
  echo "Backup y checksum subidos a s3://$S3_BUCKET/"
fi

find "$BACKUP_DIR" -type f \( -name 'coter_backup_*.sql.gz' -o -name 'coter_backup_*.sql.gz.gpg' -o -name 'coter_backup_*.sha256' \) -mtime +30 -delete
