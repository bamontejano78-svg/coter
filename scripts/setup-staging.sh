#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Coter Pro — Setup de entorno de Staging
# Uso: bash scripts/setup-staging.sh
# ═══════════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   🧠 Coter Pro — Staging Setup              ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

cd "$PROJECT_DIR"

# ─── 1. Verificar Docker ──────────────────────────────────
echo "📦 Verificando Docker..."
if ! command -v docker &> /dev/null; then
    echo ""
    echo "❌ Docker no está instalado."
    echo ""
    echo "   Opciones para instalar Docker:"
    echo "   • Windows: https://docs.docker.com/desktop/install/windows-install/"
    echo "   • winget:  winget install Docker.DockerDesktop"
    echo "   • Linux:   curl -fsSL https://get.docker.com | sh"
    echo "   • Mac:     https://docs.docker.com/desktop/install/mac-install/"
    echo ""
    echo "   Una vez instalado Docker, vuelve a ejecutar este script."
    exit 1
fi
echo "   ✅ Docker encontrado: $(docker --version)"

# ─── 2. Verificar Docker Compose ──────────────────────────
if ! docker compose version &> /dev/null; then
    echo "❌ Docker Compose no disponible. Instala Docker Desktop o el plugin compose."
    exit 1
fi
echo "   ✅ Docker Compose: $(docker compose version --short 2>/dev/null || echo 'OK')"

# ─── 3. Generar secretos ──────────────────────────────────
echo ""
echo "🔐 Generando secretos..."
JWT_SECRET=$(openssl rand -hex 64 2>/dev/null || node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
ENCRYPTION_KEY=$(openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
echo "   ✅ JWT_SECRET generado (128 caracteres hex)"
echo "   ✅ ENCRYPTION_KEY generada (64 caracteres hex)"

# ─── 4. Generar certificados SSL self-signed ──────────────
echo ""
echo "🔒 Generando certificados SSL para staging..."
mkdir -p nginx/certs

# Usar MSYS_NO_PATHCONV para evitar que Git Bash convierta rutas
MSYS_NO_PATHCONV=1 openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout nginx/certs/staging.key \
    -out nginx/certs/staging.crt \
    -config nginx/certs/ssl.cnf 2>/dev/null

if [ -f "nginx/certs/staging.crt" ]; then
    echo "   ✅ Certificados SSL generados en nginx/certs/"
else
    echo "   ⚠️  No se pudieron generar los certificados. Usando los existentes si hay."
fi

# ─── 5. Crear archivo .env.staging si falta ───────────────
echo ""
if [ -f ".env.staging" ]; then
    echo "📝 .env.staging ya existe; no se sobrescribe"
else
    echo "📝 Creando .env.staging..."

    DB_PASSWORD="${DB_PASSWORD:-$(openssl rand -hex 24 2>/dev/null || node -e 'console.log(require(\"crypto\").randomBytes(24).toString(\"hex\"))')}"

    cat > .env.staging << EOF
# ═══════════════════════════════════════════════════════════
# Coter Pro — Variables de Entorno (Staging)
# Generado automáticamente por setup-staging.sh
# Fecha: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# ═══════════════════════════════════════════════════════════

# ─── Entorno ─────────────────────────────────────────────
NODE_ENV=staging

# ─── Base de Datos ───────────────────────────────────────
# Docker Compose construye DATABASE_URL desde DB_PASSWORD.
DB_PASSWORD=${DB_PASSWORD}
API_IMAGE=coter-staging-api:local

# ─── Seguridad ───────────────────────────────────────────
JWT_SECRET=${JWT_SECRET}
ENCRYPTION_KEY=${ENCRYPTION_KEY}
ADMIN_PASSWORD=staging-admin-$(openssl rand -hex 16 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')
REFRESH_TOKEN_DAYS=30

# ─── CORS ────────────────────────────────────────────────
CORS_ORIGINS=https://localhost,https://app.localhost,http://localhost:8080,http://localhost:3000

# ─── Email (requerido en staging real) ───────────────────
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=REEMPLAZAR_CON_API_KEY_SMTP_STAGING
SMTP_FROM=staging@coter.app

# Stripe de prueba: usa claves test reales del dashboard de Stripe.
STRIPE_SECRET_KEY=sk_test_REEMPLAZAR
STRIPE_WEBHOOK_SECRET=whsec_REEMPLAZAR
STRIPE_PRICE_ID=price_REEMPLAZAR
FCM_SERVER_KEY=
FCM_SENDER_ID=
APP_URL=https://localhost

# ─── Rate Limiting (más permisivo en staging) ────────────
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=200

# ─── Logging ─────────────────────────────────────────────
LOG_LEVEL=info
EOF

    echo "   ✅ .env.staging creado con secretos internos generados"
    echo "   💡 Edita .env.staging para configurar SMTP y Stripe de prueba"
fi

# ─── 6. Validar preflight antes de construir ──────────────
echo ""
echo "🔎 Validando configuración de staging..."
if ! npm run staging:preflight; then
    echo ""
    echo "❌ .env.staging todavía no es apto para staging real."
    echo "   Completa SMTP_PASS y las claves Stripe de prueba antes de arrancar:"
    echo "   - STRIPE_SECRET_KEY=sk_test_..."
    echo "   - STRIPE_WEBHOOK_SECRET=whsec_..."
    echo "   - STRIPE_PRICE_ID=price_..."
    echo "   - SMTP_PASS=<API key SMTP real de staging>"
    echo ""
    echo "   Después vuelve a ejecutar: bash scripts/setup-staging.sh"
    exit 1
fi

# ─── 7. Construir las imágenes ────────────────────────────
echo ""
echo "🏗️  Construyendo imágenes Docker..."
docker compose -f docker-compose.staging.yml --env-file .env.staging build --no-cache
echo "   ✅ Imágenes construidas"

# ─── 8. Iniciar los servicios ─────────────────────────────
echo ""
echo "🚀 Iniciando servicios de staging..."
docker compose -f docker-compose.staging.yml --env-file .env.staging up -d
echo "   ✅ Servicios iniciando..."

# ─── 9. Esperar a que esté listo ──────────────────────────
echo ""
echo "⏳ Esperando a que la API esté lista..."
for i in $(seq 1 30); do
    if curl -sk https://localhost/api/health 2>/dev/null | grep -q '"status":"ok"'; then
        echo "   ✅ API lista en https://localhost/api/health"
        break
    fi
    sleep 2
    echo -n "."
done
echo ""

# ─── 10. Resumen ──────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   ✅ Staging listo                           ║"
echo "╠══════════════════════════════════════════════╣"
echo "║                                              ║"
echo "║   🌟 Landing (selector de rol):              ║"
echo "║      https://localhost/                       ║"
echo "║                                              ║"
echo "║   🌐 App terapeuta:                          ║"
echo "║      https://localhost/terapeuta.html         ║"
echo "║                                              ║"
echo "║   📱 App paciente:                           ║"
echo "║      https://localhost/paciente.html          ║"
echo "║                                              ║"
echo "║   🩺 Health check:                           ║"
echo "║      https://localhost/api/health             ║"
echo "║                                              ║"
echo "║   📊 Logs:                                   ║"
echo "║      docker compose -f docker-compose.staging.yml --env-file .env.staging logs -f"
echo "║                                              ║"
echo "║   🛑 Detener:                                ║"
echo "║      docker compose -f docker-compose.staging.yml --env-file .env.staging down"
echo "║                                              ║"
echo "║   ⚠️  El certificado es self-signed.         ║"
echo "║      El navegador mostrará advertencia.       ║"
echo "║      Haz clic en 'Avanzado' → 'Continuar'.   ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
