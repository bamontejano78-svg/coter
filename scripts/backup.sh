#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Coter Pro — Database Backup Script
# 
# Uso:
#   bash scripts/backup.sh                    # Backup local
#   bash scripts/backup.sh s3                 # Backup + upload a S3
# 
# Configurar en crontab:
#   0 2 * * * cd /path/to/coter && bash scripts/backup.sh s3
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
TIMESTAMP=$(date -u +"%Y%m%d_%H%M%S")
BACKUP_FILE="$BACKUP_DIR/coter_backup_$TIMESTAMP.sql.gz"

# ─── Configuración ─────────────────────────────────────────
# DATABASE_URL puede venir de .env o variable de entorno
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  source "$PROJECT_DIR/.env" 2>/dev/null
  set +a
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "❌ ERROR: DATABASE_URL no está configurada."
  echo "   Define DATABASE_URL en .env o como variable de entorno."
  exit 1
fi

# ─── Crear directorio de backups ───────────────────────────
mkdir -p "$BACKUP_DIR"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   🧠 Coter Pro — Database Backup            ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "   📅 Timestamp:  $TIMESTAMP"
echo "   📁 Backup:     $BACKUP_FILE"
echo ""

# ─── Ejecutar pg_dump ──────────────────────────────────────
echo "⏳ Realizando backup..."
if pg_dump "$DATABASE_URL" --no-owner --no-acl 2>/tmp/coter_backup_err.log | gzip > "$BACKUP_FILE"; then
  SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
  echo "   ✅ Backup completado: $BACKUP_FILE ($SIZE)"
else
  echo "   ❌ Error en pg_dump:"
  cat /tmp/coter_backup_err.log
  rm -f /tmp/coter_backup_err.log
  exit 1
fi
rm -f /tmp/coter_backup_err.log

# ─── Upload a S3 (opcional) ────────────────────────────────
if [ "${1:-}" = "s3" ]; then
  S3_BUCKET="${S3_BACKUP_BUCKET:-}"
  if [ -z "$S3_BUCKET" ]; then
    echo "   ⚠️  S3_BACKUP_BUCKET no configurado. Saltando upload."
  elif command -v aws &> /dev/null; then
    echo "   ☁️  Subiendo a S3: s3://$S3_BUCKET/"
    aws s3 cp "$BACKUP_FILE" "s3://$S3_BUCKET/$(basename "$BACKUP_FILE")" --storage-class STANDARD_IA
    echo "   ✅ Upload completado"
  else
    echo "   ⚠️  AWS CLI no instalado. Instala con: pip install awscli"
    echo "   ⚠️  Saltando upload a S3."
  fi
fi

# ─── Limpieza: retener últimos 30 días ─────────────────────
echo "   🧹 Limpiando backups antiguos (>30 días)..."
find "$BACKUP_DIR" -name "coter_backup_*.sql.gz" -mtime +30 -delete
echo "   ✅ Limpieza completada"

BACKUP_COUNT=$(find "$BACKUP_DIR" -name "coter_backup_*.sql.gz" | wc -l)
echo ""
echo "   📊 Total backups almacenados: $BACKUP_COUNT"
echo ""
echo "╚══════════════════════════════════════════════╝"
echo ""
