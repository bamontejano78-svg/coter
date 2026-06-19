#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Coter Pro — Obtener certificado SSL inicial (Let's Encrypt)
#
# Uso:
#   bash scripts/get-ssl.sh tu@email.com
#
# Requisitos previos:
#   - Dominios coter.app y app.coter.app apuntando a este servidor
#   - Puerto 80 abierto en el firewall
#   - .env configurado con DATABASE_URL, JWT_SECRET, etc.
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

EMAIL="${1:-}"
if [ -z "$EMAIL" ]; then
  echo ""
  echo "❌ Debes proporcionar un email para Let's Encrypt."
  echo ""
  echo "   Uso: bash scripts/get-ssl.sh tu@email.com"
  echo ""
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

CERT_PATH="/etc/letsencrypt/live/coter.app/fullchain.pem"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   🔒 Coter Pro — SSL inicial                ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ─── 1. Verificar si ya existe el certificado ───────────
if [ -f "$CERT_PATH" ]; then
  echo "✅ El certificado ya existe en $CERT_PATH"
  echo "   No es necesario ejecutar este script de nuevo."
  echo ""
  echo "   Para renovar: certbot renew"
  echo "   O espera a que el contenedor certbot lo haga automáticamente."
  exit 0
fi

echo "📋 El certificado NO existe aún. Vamos a obtenerlo."
echo ""

# ─── 2. Verificar Docker ────────────────────────────────
if ! command -v docker &> /dev/null; then
  echo "❌ Docker no está instalado."
  exit 1
fi

# ─── 3. Arrancar solo postgres + API (sin nginx) ───────
echo "⏳ Iniciando base de datos y API..."
docker compose up -d postgres api 2>&1 | tail -1

# Esperar a que la API esté lista
echo "⏳ Esperando a que la API responda..."
for i in $(seq 1 30); do
  if curl -s http://localhost:3000/api/health 2>/dev/null | grep -q '"status":"ok"'; then
    echo "   ✅ API lista"
    break
  fi
  sleep 2
  echo -n "."
done
echo ""

# ─── 4. Iniciar nginx con config INIT (solo HTTP) ──────
echo "⏳ Iniciando nginx en modo INIT (solo HTTP)..."
# Usar el config init en vez del de producción
docker compose stop nginx 2>/dev/null || true

# Iniciar nginx con config init
docker run -d --rm \
  --name coter-nginx-init \
  --network coter_coter \
  -p 80:80 \
  -v "$PROJECT_DIR/nginx/nginx.init.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v certbot_www:/var/www/certbot \
  nginx:1.27-alpine 2>/dev/null

sleep 3
echo "   ✅ Nginx init corriendo en puerto 80"

# Verificar que nginx init responde
if curl -s http://localhost/ 2>/dev/null | head -1 | grep -q .; then
  echo "   ✅ Nginx init responde correctamente"
else
  echo "   ⚠️  Nginx init no parece responder. Continuando de todos modos..."
fi

# ─── 5. Obtener el certificado con certbot ──────────────
echo ""
echo "🔐 Solicitando certificado SSL a Let's Encrypt..."
echo "   Dominios: coter.app, app.coter.app"
echo "   Email:    $EMAIL"
echo ""

docker run --rm \
  -v /etc/letsencrypt:/etc/letsencrypt \
  -v certbot_www:/var/www/certbot \
  certbot/certbot certonly --webroot \
  -w /var/www/certbot \
  -d coter.app -d app.coter.app \
  --email "$EMAIL" \
  --agree-tos \
  --non-interactive

if [ -f "$CERT_PATH" ]; then
  echo ""
  echo "   ✅ ¡Certificado obtenido correctamente!"
else
  echo ""
  echo "   ❌ No se pudo obtener el certificado."
  echo "   Verifica que:"
  echo "   - Los dominios apuntan a este servidor (DNS configurado)"
  echo "   - El puerto 80 está abierto en el firewall"
  echo "   - No hay otro servicio usando el puerto 80"
  exit 1
fi

# ─── 6. Detener nginx init ──────────────────────────────
echo ""
echo "🔄 Cambiando a nginx producción (HTTPS)..."
docker stop coter-nginx-init 2>/dev/null || true

# ─── 7. Iniciar nginx con config PRODUCCIÓN ─────────────
docker compose up -d nginx 2>&1 | tail -1

sleep 3

# ─── 8. Verificar ────────────────────────────────────────
echo ""
echo "🔍 Verificando HTTPS..."
if curl -sk https://localhost/api/health 2>/dev/null | grep -q '"status":"ok"'; then
  echo "   ✅ HTTPS funcionando en https://localhost/api/health"
else
  echo "   ⚠️  HTTPS no responde aún. Espera unos segundos y prueba:"
  echo "   curl -k https://localhost/api/health"
fi

# ─── 9. Iniciar certbot (renovación automática) ─────────
echo ""
echo "⏳ Iniciando renovación automática..."
docker compose up -d certbot 2>&1 | tail -1

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   ✅ SSL configurado                         ║"
echo "╠══════════════════════════════════════════════╣"
echo "║                                              ║"
echo "║   🌐 App:    https://coter.app               ║"
echo "║   🩺 Health: https://coter.app/api/health    ║"
echo "║   🔄 Renovación automática cada 12h          ║"
echo "║                                              ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
