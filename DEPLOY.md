# 🚀 Coter Pro — Guía de Despliegue a Producción

## Requisitos del servidor

| Componente | Mínimo | Recomendado |
|------------|--------|-------------|
| **CPU** | 2 vCPU | 4 vCPU |
| **RAM** | 2 GB | 4 GB |
| **Disco** | 20 GB SSD | 40 GB SSD |
| **SO** | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |
| **Docker** | 24+ | 27+ |
| **Docker Compose** | v2 | v2 |

## Paso 1: Preparar el servidor

```bash
# Actualizar sistema
sudo apt update && sudo apt upgrade -y

# Instalar Docker
curl -fsSL https://get.docker.com | sudo bash
sudo usermod -aG docker $USER
newgrp docker

# Instalar Certbot para SSL
sudo apt install -y certbot

# Clonar el repositorio
git clone https://github.com/bamontejano78-svg/coter.git /opt/coter
cd /opt/coter
```

## Paso 2: Configurar variables de entorno

```bash
# Copiar y editar el template de producción
cp .env.production .env
nano .env
```

### Variables críticas (OBLIGATORIAS)

| Variable | Cómo obtenerla |
|----------|---------------|
| `JWT_SECRET` | `openssl rand -hex 64` |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` |
| `DATABASE_URL` | URL de PostgreSQL (Neon, Railway, Supabase, etc.) |
| `SMTP_PASS` | API Key de Resend (https://resend.com) |
| `STRIPE_SECRET_KEY` | Dashboard de Stripe → Developers → API Keys |
| `STRIPE_WEBHOOK_SECRET` | Dashboard de Stripe → Webhooks → Signing secret |
| `FCM_SERVER_KEY` | Firebase Console → Cloud Messaging → Server key |
| `ADMIN_PASSWORD` | Contraseña segura para /admin |

### Variables opcionales (recomendadas en producción)

| Variable | Valor recomendado |
|----------|-------------------|
| `LOG_LEVEL` | `info` (no `debug` en prod) |
| `DB_POOL_MIN` | `4` |
| `DB_POOL_MAX` | `20` |
| `CORS_ORIGINS` | `https://coter.app,https://app.coter.app` |
| `APP_URL` | `https://coter.app` |

## Paso 3: Configurar DNS

Asegúrate de que estos registros DNS apunten a la IP del servidor:

```
coter.app     A  →  <IP_DEL_SERVIDOR>
app.coter.app A  →  <IP_DEL_SERVIDOR>
```

## Paso 4: Primer despliegue

```bash
# Dar permisos de ejecución al script
chmod +x scripts/deploy-prod.sh

# Desplegar con inicialización SSL
./scripts/deploy-prod.sh --init
```

El script hará automáticamente:
1. ✅ Verificar variables de entorno
2. ✅ Obtener certificado SSL (Let's Encrypt)
3. ✅ Descargar imagen Docker desde GHCR
4. ✅ Iniciar PostgreSQL + API + Nginx + Certbot
5. ✅ Verificar health check
6. ✅ Aplicar migraciones de BD

## Paso 5: Verificar

```bash
# Health check
curl https://coter.app/api/health

# Debe devolver: {"status":"ok","database":"connected",...}

# Ver servicios
docker compose ps

# Ver logs
docker compose logs -f
```

## Despliegues posteriores

```bash
# Pull de la última imagen y redeploy
./scripts/deploy-prod.sh
```

## Migraciones de BD

Las migraciones se aplican automáticamente al iniciar la API (`initializeDatabase()` en `database.js`).

### Lista de migraciones (orden de aplicación):

| # | Archivo | Descripción |
|---|---------|-------------|
| 1 | `001_initial.sql` | Tablas base (therapists, patients, check_ins, messages, etc.) |
| 2 | `002_patient_tokens.sql` | Auth tokens para pacientes |
| 3 | `003_refresh_tokens.sql` | Refresh tokens para terapeutas |
| 4 | `004_add_patient_name.sql` | Campo patient_name en connection_codes |
| 5 | `005_alter_types.sql` | Ajustes de tipos de columnas |
| 6 | `006_unique_reminder_index.sql` | Índice único de recordatorios |
| 7 | `007_embedded_exercises.sql` | Ejercicios clínicos embebidos (TR/BA/GE) |
| 8 | `008_billing.sql` | Tablas de facturación (subscriptions, billing_events) |
| 9 | `009_stripe_webhook_idempotency.sql` | Idempotencia de webhooks Stripe |
| 10 | `010_pioneer_system.sql` | Sistema de Pioneros |
| 11 | `011_pioneer_applications.sql` | Solicitudes de Pioneros |
| 12 | `012_clinical_alerts_and_scales.sql` | Alertas y escalas clínicas |
| 13 | `013_widget_exercise_kinds.sql` | Exercise kinds para widgets |
| 14 | `014_push_tokens.sql` | Push tokens FCM para pacientes |
| 15 | `015_clinical_sessions.sql` | Sesiones clínicas + session_id en notas |
| 16 | `016_therapist_push_tokens.sql` | Push tokens FCM para terapeutas |

## Monitoreo

```bash
# Uso de recursos
docker stats

# Logs en tiempo real
docker compose logs -f api

# Logs de Nginx
docker compose logs -f nginx

# Backup de BD
docker compose exec postgres pg_dump -U coter coter > backup_$(date +%Y%m%d).sql
```

## Rollback

```bash
# Volver a un tag específico
git checkout v2.5.0
docker compose up -d --build
```

## CI/CD (GitHub Actions)

El pipeline se ejecuta automáticamente en cada push a `main` y en cada tag:

```
Push a main → test → docker build/scan → push a GHCR → deploy staging
Push de tag → test → docker build/scan → push a GHCR (con tags semver)
```

Imágenes en GHCR: `ghcr.io/bamontejano78-svg/coter:2.6.0`
