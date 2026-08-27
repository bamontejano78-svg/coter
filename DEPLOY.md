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
# Crear .env desde el template
cp .env.example .env
nano .env
```

> **IMPORTANTE:** En producción, `DATABASE_URL` debe apuntar al contenedor Postgres local,
> NO a Neon. La arquitectura es autocontenida: cada entorno lleva su propia BD.
>
> ```env
> DB_PASSWORD=<OUTPUT_OF_openssl_rand_-hex_24>
> ```
> Docker Compose construye DATABASE_URL desde DB_PASSWORD para el servicio PostgreSQL local.
> Si usas una base PostgreSQL gestionada para staging o QA, configura la URL con
> `sslmode=verify-full` para mantener la verificación TLS actual de `pg`.

### Variables críticas (OBLIGATORIAS)

| Variable | Cómo obtenerla |
|----------|---------------|
| `JWT_SECRET` | `openssl rand -hex 64` |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` |
| `DB_PASSWORD` | `openssl rand -hex 24` (solo caracteres hexadecimales) |
| `SMTP_PASS` | API Key de Resend (https://resend.com) |
| `CORS_ORIGINS` | Origenes HTTPS publicos separados por comas |
| `STRIPE_SECRET_KEY` | Dashboard de Stripe → Developers → API Keys |
| `STRIPE_WEBHOOK_SECRET` | Dashboard de Stripe → Webhooks → Signing secret |
| `FCM_SERVER_KEY` | Firebase Console → Cloud Messaging → Server key |
| `ADMIN_PASSWORD` | Contraseña segura para /admin |
| `STRIPE_PRICE_ID` | ID del precio activo en Stripe |
| `STAGING_URL` | URL HTTPS del staging usada por CI |
| `API_IMAGE` | Tag/imagen inmutable de GHCR a desplegar en producción |
| `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`, `STAGING_DEPLOY_PATH` | Acceso SSH al servidor de staging |

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
4. ✅ Iniciar PostgreSQL + API + Nginx y dejar renovación SSL en cron del host
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

Las migraciones se aplican automáticamente al iniciar la API (`initializeDatabase()` en `database.js`). Se serializan mediante un advisory lock de PostgreSQL para evitar ejecuciones concurrentes durante rolling deploys; el arranque falla si una migración no puede completarse.

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
| 17 | `017_stripe_webhook_processing.sql` | Estado y recuperación de procesamiento de webhooks Stripe |
| 18 | `018_therapist_2fa.sql` | 2FA TOTP y códigos de respaldo para terapeutas |
| 19 | `019_admin_2fa.sql` | 2FA TOTP y códigos de respaldo para administración |
| 20 | `020_patient_access_audit.sql` | Auditoría persistente de accesos a fichas clínicas |
| 21 | `021_clinical_alerts_columns.sql` | Reconciliación de columnas de alertas clínicas |

## Monitoreo

```bash
# Uso de recursos
docker stats

# Logs en tiempo real
docker compose logs -f api

# Logs de Nginx
docker compose logs -f nginx

# Backup cifrado de BD (requiere BACKUP_ENCRYPTION_KEY_FILE en producción)
# El archivo de passphrase debe estar fuera del repositorio y protegido por permisos 0600.
BACKUP_ENCRYPTION_KEY_FILE=/etc/coter/backup-passphrase \\
  bash scripts/backup.sh s3

# Restauración SOLO en una base aislada (nunca en producción)
RESTORE_DATABASE_URL=postgresql://... \\
BACKUP_ENCRYPTION_KEY_FILE=/etc/coter/backup-passphrase \\
  bash scripts/restore-backup.sh /ruta/al/backup.sql.gz.gpg

El script rechaza URLs que parezcan de producción. La restauración debe ejecutarse
con una base temporal/aislada y documentarse como prueba de recuperación.

# Ensayo completo backup -> restore -> sanity check en una BD temporal
SOURCE_DATABASE_URL=postgresql://... \\
DRILL_ADMIN_DATABASE_URL=postgresql://.../postgres \\
BACKUP_ENCRYPTION_KEY_FILE=/etc/coter/backup-passphrase \\
  bash scripts/backup-restore-drill.sh
```

## Rollback

```bash
# Seleccionar una versión previamente validada; nunca desplegar :main como rollback.
export API_IMAGE=ghcr.io/bamontejano78-svg/coter:<VERSION_VALIDADA>
docker compose -f docker-compose.yml up -d --no-build

# Verificar antes de reabrir tráfico
curl -fsS https://coter.app/api/health
```

## CI/CD (GitHub Actions)

El deploy remoto de staging requiere y valida `STAGING_URL` además de las credenciales SSH. Si esos secrets no están configurados, el job falla explícitamente en vez de reportar un despliegue ficticio. El smoke test ejecuta `node scripts/staging-smoke.js`: valida `/api/health`, exige `environment=staging` y comprueba que las páginas principales HTML responden.

Antes de arrancar el host de staging, crea el archivo real fuera de Git y valida su forma sin imprimir secretos:

```bash
cp .env.staging.example .env.staging
npm run staging:preflight
```

Para ver todos los bloqueos operativos de una vez:

```bash
npm run staging:readiness
```

Si `staging:readiness` indica que falta autenticación o secrets de GitHub:

```bash
gh auth login -h github.com

gh secret set TEST_DB_PASSWORD --repo bamontejano78-svg/coter
gh secret set TEST_JWT_SECRET --repo bamontejano78-svg/coter
gh secret set TEST_ENCRYPTION_KEY --repo bamontejano78-svg/coter
gh secret set SSH_HOST --repo bamontejano78-svg/coter
gh secret set SSH_USER --repo bamontejano78-svg/coter
gh secret set SSH_PRIVATE_KEY --repo bamontejano78-svg/coter
gh secret set STAGING_DEPLOY_PATH --repo bamontejano78-svg/coter
gh secret set STAGING_URL --repo bamontejano78-svg/coter
```

Después del deploy:

```bash
STAGING_URL=https://staging.coter.app npm run staging:smoke
```

El pipeline ejecuta tests en PRs; solo publica imágenes en `main`/tags. El deploy remoto de staging requiere secrets configurados y debe validarse antes de una release de producción. La imagen de producción debe fijarse a un tag o SHA, no a `:main`:

```
Push a main → test → docker build/scan → push a GHCR → deploy staging
Push de tag → test → docker build/scan → push a GHCR (con tags semver)
```

Imágenes en GHCR: `ghcr.io/bamontejano78-svg/coter:<tag-o-sha>`.

En producción, `API_IMAGE` debe apuntar a un tag de release o digest inmutable. No usar `:main` porque dificulta rollback y puede cambiar durante un despliegue.
