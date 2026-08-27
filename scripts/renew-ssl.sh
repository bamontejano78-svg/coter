#!/usr/bin/env bash
# Coter Pro — Renovación de certificados Let's Encrypt
# Ejecutar desde cron/systemd en el host, no dentro del contenedor Certbot.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.certbot.yml"

cd "$PROJECT_DIR"

echo "Renovando certificados Let's Encrypt..."
sudo docker compose -f "$COMPOSE_FILE" run --rm certbot

echo "Recargando Nginx..."
sudo docker compose --env-file "$PROJECT_DIR/.env" -f "$PROJECT_DIR/docker-compose.yml" exec -T nginx nginx -s reload
echo "Renovación SSL completada."
