#!/usr/bin/env bash
# ============================================================
# Coter Pro — Deploy Staging (Local)
# ============================================================
# Despliega la imagen más reciente de GHCR en tu máquina local
# usando docker-compose.staging.yml.
#
# Requisitos:
#   - Docker + Docker Compose instalados
#   - Haber hecho 'docker login ghcr.io' con tu token de GitHub
#   - Variables de entorno en .env o definidas en el shell
#
# Uso:
#   chmod +x scripts/deploy-staging-local.sh
#   ./scripts/deploy-staging-local.sh
# ============================================================
set -e

# ─── Configuración ──────────────────────────────────────────
REGISTRY="ghcr.io"
REPO="bamontejano78-svg/coter"
IMAGE="${REGISTRY}/${REPO}:main"
DEPLOY_PATH="$(cd "$(dirname "$0")/.." && pwd)"

# ─── Cargar .env si existe ──────────────────────────────────
if [ -f "$DEPLOY_PATH/.env" ]; then
  echo "📄 Cargando variables desde .env..."
  set -a
  source "$DEPLOY_PATH/.env"
  set +a
fi

# ─── Pull image ──────────────────────────────────────────────
echo "📥 Pulling latest image: $IMAGE"
if ! docker pull "$IMAGE"; then
  echo ""
  echo "❌ Pull falló. Posibles causas:"
  echo "   - No autenticado: ejecuta 'echo TU_TOKEN | docker login ghcr.io -u TU_USER --password-stdin'"
  echo "   - Imagen no existe aún en GHCR (espera a que el CI termine)"
  echo "   - Error de red"
  exit 1
fi

# ─── Desplegar ──────────────────────────────────────────────
cd "$DEPLOY_PATH"

echo "🚀 Starting staging services..."
API_IMAGE="$IMAGE" \
  docker compose -f docker-compose.staging.yml up -d --no-build --force-recreate api

# ─── Health check ───────────────────────────────────────────
echo "⏳ Waiting for health check..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:3000/api/health > /dev/null 2>&1; then
    echo "✅ API healthy after $((i * 2))s"
    break
  fi
  [ $i -eq 30 ] && echo "❌ Health check timeout" && exit 1
  sleep 2
done

# ─── Limpieza ───────────────────────────────────────────────
echo "🧹 Pruning old images..."
docker image prune -af --filter "until=24h" || true

echo ""
echo "✅ Deploy completo!"
echo "   App: http://localhost:3000"
echo "   Para ver logs: docker compose -f docker-compose.staging.yml logs -f api"
