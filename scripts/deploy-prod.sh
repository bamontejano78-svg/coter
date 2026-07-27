#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Coter Pro — Deploy Script para Producción
# ═══════════════════════════════════════════════════════════════
# Uso: ./scripts/deploy-prod.sh [--init]
#
#   ./scripts/deploy-prod.sh          → Deploy normal (pull + up)
#   ./scripts/deploy-prod.sh --init   → Primer deploy (SSL + setup completo)
#
# Requisitos:
#   - Docker + Docker Compose instalados
#   - .env configurado con valores de producción
#   - Dominio coter.app apuntando al servidor (DNS)
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"
DOCKER_COMPOSE="$PROJECT_DIR/docker-compose.yml"
FIRST_RUN=false

# ─── Parse args ───────────────────────────────────────────────
if [[ "${1:-}" == "--init" ]]; then
  FIRST_RUN=true
fi

# ─── Colores ──────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${BLUE}[DEPLOY]${NC} $1"; }
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; }

# ─── Verificar entorno ────────────────────────────────────────
cd "$PROJECT_DIR"

log "Verificando entorno..."

if [[ ! -f "$ENV_FILE" ]]; then
  err "No se encontró .env en $PROJECT_DIR"
  echo "  Copia .env.production a .env y completa los valores:"
  echo "  cp .env.production .env"
  exit 1
fi

# Cargar variables de entorno
set -a
source "$ENV_FILE"
set +a

if [[ "$NODE_ENV" != "production" ]]; then
  err "NODE_ENV debe ser 'production'. Actual: '$NODE_ENV'"
  exit 1
fi

# ─── Verificar variables críticas ─────────────────────────────
CRITICAL_VARS=("JWT_SECRET" "ENCRYPTION_KEY" "DATABASE_URL" "SMTP_PASS" "STRIPE_SECRET_KEY")
MISSING=()
for var in "${CRITICAL_VARS[@]}"; do
  if [[ -z "${!var:-}" ]] || [[ "${!var}" == *"REEMPLAZAR"* ]]; then
    MISSING+=("$var")
  fi
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  err "Las siguientes variables de entorno NO están configuradas:"
  for var in "${MISSING[@]}"; do
    echo "  - $var"
  done
  exit 1
fi

ok "Variables de entorno verificadas"

# ─── Primer despliegue: SSL + Docker ──────────────────────────
if [[ "$FIRST_RUN" == "true" ]]; then
  log "=== PRIMER DESPLIEGUE (--init) ==="

  # Verificar que Docker esté instalado
  if ! command -v docker &>/dev/null; then
    err "Docker no está instalado. Instálalo primero: https://docs.docker.com/engine/install/"
    exit 1
  fi

  # Crear directorios de datos persistentes
  log "Creando directorios de datos..."
  sudo mkdir -p /var/www/certbot

  # Obtener certificado SSL inicial con Certbot standalone
  log "Solicitando certificado SSL inicial para coter.app..."
  if [[ ! -d "/etc/letsencrypt/live/coter.app" ]]; then
    # Detener cualquier servicio en puerto 80
    sudo docker compose -f "$DOCKER_COMPOSE" down 2>/dev/null || true

    # Certbot standalone
    sudo certbot certonly --standalone \
      --non-interactive --agree-tos \
      --email "${SMTP_FROM:-noreply@coter.app}" \
      -d coter.app -d app.coter.app

    if [[ $? -ne 0 ]]; then
      err "Error al obtener certificado SSL. Verifica:"
      echo "  1. Los dominios coter.app y app.coter.app apuntan a este servidor"
      echo "  2. El puerto 80 está abierto en el firewall"
      exit 1
    fi
    ok "Certificado SSL obtenido para coter.app"
  else
    ok "Certificado SSL ya existe en /etc/letsencrypt/live/coter.app"
  fi

  # Configurar renovación automática
  log "Configurando renovación automática de SSL..."
  sudo crontab -l 2>/dev/null | grep -v "certbot renew" > /tmp/crontab_tmp || true
  echo "0 3 * * * certbot renew --quiet --deploy-hook 'docker exec coter-nginx nginx -s reload'" >> /tmp/crontab_tmp
  sudo crontab /tmp/crontab_tmp
  rm /tmp/crontab_tmp
  ok "Renovación automática configurada (cron diario a las 3am)"
fi

# ─── Pull de imagen Docker ────────────────────────────────────
log "Descargando imagen más reciente desde GHCR..."
sudo docker compose -f "$DOCKER_COMPOSE" pull api
ok "Imagen descargada"

# ─── Construir y desplegar ────────────────────────────────────
log "Iniciando servicios..."
sudo docker compose -f "$DOCKER_COMPOSE" up -d --build --remove-orphans
ok "Servicios iniciados"

# ─── Esperar a que la API esté saludable ──────────────────────
log "Esperando a que la API esté lista (health check)..."
ATTEMPTS=0
MAX_ATTEMPTS=30
while [[ $ATTEMPTS -lt $MAX_ATTEMPTS ]]; do
  if curl -sf http://localhost:3000/api/health > /dev/null 2>&1; then
    ok "API saludable"
    break
  fi
  sleep 2
  ATTEMPTS=$((ATTEMPTS + 1))
done

if [[ $ATTEMPTS -eq $MAX_ATTEMPTS ]]; then
  err "La API no respondió después de ${MAX_ATTEMPTS} intentos"
  echo "  Revisa los logs: sudo docker compose -f $DOCKER_COMPOSE logs api"
  exit 1
fi

# ─── Aplicar migraciones ──────────────────────────────────────
log "Aplicando migraciones de base de datos..."
sudo docker compose -f "$DOCKER_COMPOSE" exec -T api node -e "
  const { initializeDatabase } = require('./database');
  initializeDatabase().then(() => {
    console.log('Migraciones aplicadas correctamente');
    process.exit(0);
  }).catch(err => {
    console.error('Error aplicando migraciones:', err.message);
    process.exit(1);
  });
"

if [[ $? -eq 0 ]]; then
  ok "Migraciones aplicadas"
else
  err "Error al aplicar migraciones"
  echo "  Revisa los logs: sudo docker compose -f $DOCKER_COMPOSE logs api"
  exit 1
fi

# ─── Recargar Nginx ───────────────────────────────────────────
log "Recargando Nginx..."
sudo docker compose -f "$DOCKER_COMPOSE" exec nginx nginx -s reload 2>/dev/null || \
  sudo docker compose -f "$DOCKER_COMPOSE" restart nginx
ok "Nginx recargado"

# ─── Verificación final ───────────────────────────────────────
log "=== Verificación final ==="

# Health check via HTTPS si el certificado existe
if [[ -d "/etc/letsencrypt/live/coter.app" ]]; then
  if curl -sf https://coter.app/api/health > /dev/null 2>&1; then
    ok "HTTPS: https://coter.app/api/health → OK"
  else
    warn "HTTPS: No se pudo verificar https://coter.app (puede tardar unos segundos)"
  fi
fi

# Verificar servicios
sudo docker compose -f "$DOCKER_COMPOSE" ps

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ DEPLOY COMPLETADO${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo ""
echo "  URL:        https://coter.app"
echo "  API:        https://coter.app/api/health"
echo "  Terapeuta:  https://coter.app/terapeuta.html"
echo "  Paciente:   https://coter.app/paciente.html"
echo "  Admin:      https://coter.app/admin.html"
echo ""
echo "  Logs:       sudo docker compose -f $DOCKER_COMPOSE logs -f"
echo "  Status:     sudo docker compose -f $DOCKER_COMPOSE ps"
echo ""

if [[ "$FIRST_RUN" == "true" ]]; then
  echo -e "${YELLOW}⚠️  Asegúrate de configurar estos GitHub Secrets para CI/CD:${NC}"
  echo "  SSH_HOST, SSH_USER, SSH_PRIVATE_KEY, STAGING_DEPLOY_PATH"
  echo ""
fi
