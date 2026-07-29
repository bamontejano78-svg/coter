# 🧠 Coter Pro — Checkpoint de Sesión

**Fecha:** 2026-07-29
**Último commit:** `2d442eb` (docs: plan de deploy — Docker + Postgres local)
**Branch:** `main`
**Tests:** 295/295 ✅

---

## 📦 Lo hecho esta sesión

| Tarea | Archivos |
|-------|----------|
| 🔄 **Migración a nuevo disco** | Proyecto movido de `D:` a `E:\proyectos gpt\coter 4.0` |
| 🔧 **dotenv v17 fix** | `config/env.js`, `scripts/check-test-db.js` — `override:true` + preservar `NODE_ENV` |
| 📦 **package-lock.json restaurado** | `git show HEAD:package-lock.json` + `npm ci` (npm 11 tenía bugs) |
| 🗄️ **DATABASE_URL actualizada** | `.env`, `neon.txt` — nuevas credenciales de Neon |
| 🩺 **Trial subscription para test** | Insertada fila en `subscriptions` para `ana@coter.com` (estaba bloqueando el billingGuard) |
| 🔒 **.gitignore actualizado** | Excluye `neon.txt` y `android/app/google-services.json` |
| 💳 **Stripe Checkout UI** | `www/js/therapist-billing.js`, `www/terapeuta.html`, `www/css/therapist.css` |
| 🐳 **Plan de deploy** | `CHECKPOINT.md`, `DEPLOY.md` — arquitectura Docker+Postgres local, checklist |
| ❌ **Deploy staging bloqueado** | Docker Desktop no instalado en esta máquina |

### 📊 Lo implementado en sesiones anteriores

| Feature | Archivos |
|---------|----------|
| 📊 **Analytics Dashboard** | `routes/therapist.js`, `www/terapeuta.html`, `www/js/therapist.js`, `www/css/therapist.css` |
| 📄 **Export PDF/CSV** | `routes/therapist.js` (generateHTMLReport, generateCSV), `www/js/therapist.js` |
| 🔔 **FCM Push P↔T** | `utils/fcm.js`, `routes/therapist.js`, `routes/patients.js`, `migrations/014,016` |
| 📅 **Clinical Sessions** | `routes/therapist.js` (CRUD), `www/terapeuta.html`, `www/js/therapist.js`, `migrations/015` |
| 📖 **DEPLOY.md** | Guía completa de despliegue a producción |
| 🚀 **deploy-prod.sh** | Script de deploy con `--init` para SSL + migraciones |
| 📋 **.env.example** | Template de variables de entorno |

---

## 🟢 Estado actual: desarrollo local funcionando

```bash
cd "E:\proyectos gpt\coter 4.0"
npm run dev
# → http://localhost:3000
# → Health check: {"status":"ok","database":"connected"}
# → Tests: 295/295 ✅
```

### Accesos:
- **Terapeuta:** http://localhost:3000/terapeuta.html (`ana@coter.com` / `123456`)
- **Paciente:** http://localhost:3000/paciente.html
- **Admin:** http://localhost:3000/admin.html

### ⚠️ Servidor en ejecución
El servidor de desarrollo está corriendo en segundo plano (PID 7896, puerto 3000).
Para detenerlo: `taskkill //F //PID 7896`

---

## 🚀 PRÓXIMO PASO: Instalar Docker + probar deploy staging

### ✅ Decisión tomada: Docker + Postgres local

Cada entorno es **autocontenido**: Docker Compose con su propio Postgres, sin dependencia de Neon en producción.

| Entorno | BD | Docker Compose | Nginx | SSL |
|---------|-----|---------------|-------|-----|
| **Dev local** | Neon serverless | No se usa | No se usa | No |
| **Staging** | Postgres 16 contenedor | `docker-compose.staging.yml` | Self-signed | No |
| **Producción** | Postgres 16 contenedor | `docker-compose.yml` | Let's Encrypt | ✅ Auto-renew |

### 🔴 Bloqueante: Docker Desktop no instalado

El script `scripts/deploy-staging-local.sh` falla porque `docker` no está en el PATH.
Para continuar en la próxima sesión:

1. **Instalar Docker Desktop** → https://www.docker.com/products/docker-desktop/
   - Instalar con opción **WSL 2**
   - Reiniciar Windows
   - Verificar: `docker --version` y `docker compose version`

2. **Autenticarse en GHCR:**
   ```bash
   echo "TU_GITHUB_TOKEN" | docker login ghcr.io -u bamontejano78-svg --password-stdin
   ```

3. **Ejecutar deploy staging:**
   ```bash
   ./scripts/deploy-staging-local.sh
   ```

### Arquitectura de producción

```
┌─────────────────────────────────────────┐
│  VPS (Ubuntu 22.04/24.04)               │
│  ┌───────────────────────────────────┐  │
│  │ nginx :80/:443 ──→ api :3000     │  │
│  │ certbot (auto-renew SSL)          │  │
│  │ api (Node.js desde GHCR)          │  │
│  │ postgres :5432 (datos en volumen)  │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

---

### 📋 Plan de deploy — Paso a paso

#### 🔹 Opción A: Staging local (probar antes de producción)

```bash
# 1. Pull de la última imagen desde GHCR y arrancar
./scripts/deploy-staging-local.sh

# 2. Verificar
curl http://localhost:3000/api/health
docker compose -f docker-compose.staging.yml ps

# 3. Probar flujo completo en staging
# → http://localhost:3000/terapeuta.html
```

#### 🔹 Opción B: Producción (servidor real)

```bash
# 1. Preparar el servidor (ver DEPLOY.md)
#    - Ubuntu 22.04+ con Docker + Docker Compose
#    - DNS: coter.app + app.coter.app → IP del servidor
#    - git clone en /opt/coter

# 2. Configurar .env de producción en el servidor
#    - JWT_SECRET, ENCRYPTION_KEY, ADMIN_PASSWORD (generar nuevos)
#    - DATABASE_URL apunta al postgres del contenedor (no Neon)
#    - STRIPE_SECRET_KEY (modo live), STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID
#    - SMTP_PASS, FCM_SERVER_KEY

# 3. Primer deploy con SSL
./scripts/deploy-prod.sh --init

# 4. Verificar
curl https://coter.app/api/health
docker compose ps
```

#### 📦 Checklist de credenciales (para el .env de producción)

| Variable | Cómo obtenerla | ¿Crítico? |
|----------|---------------|-----------|
| `JWT_SECRET` | `openssl rand -hex 64` | ✅ |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` | ✅ |
| `ADMIN_PASSWORD` | Elegir una segura | ✅ |
| `DATABASE_URL` | `postgresql://coter:coter@postgres:5432/coter` | ✅ |
| `STRIPE_SECRET_KEY` | Stripe Dashboard → API Keys (live) | ✅ |
| `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard → Webhooks | ✅ |
| `STRIPE_PRICE_ID` | Stripe Dashboard → Productos | ✅ |
| `SMTP_PASS` | Resend API key | ⚠️ |
| `FCM_SERVER_KEY` | Firebase Console → Cloud Messaging | ⚠️ |

---

## 📊 Estado del proyecto

| Área | Estado |
|------|--------|
| Tests | 295/295 ✅ |
| CI/CD | GitHub Actions (test → build → push GHCR → deploy placeholder) |
| GHCR | `ghcr.io/bamontejano78-svg/coter:v2.6.0` |
| Migraciones | 16 aplicadas (001 → 016) |
| Frontend | Terapeuta + Paciente + Admin + Landing |
| Widgets | 9 widgets interactivos (3 categorías) |
| Push notifications | Paciente ↔ Terapeuta (FCM) |
| Billing | Stripe infraestructura + Checkout UI ✅ |
| SSL | nginx.conf listo para Let's Encrypt |

---

## 💳 Stripe Checkout UI — Implementado

- **Frontend:** `www/js/therapist-billing.js` — módulo autocontenido
- **Estilos:** `www/css/therapist.css` — clases `.billing-*`
- **HTML:** `www/terapeuta.html` — tab `#tab-billing` con skeleton loading
- **Backend:** `routes/billing.js` — `/status`, `/usage`, `/create-checkout`, `/webhook`

### Funcionalidades:
- ✅ Estado de suscripción (trial, active, past_due, canceled)
- ✅ Barra de progreso del trial con días restantes
- ✅ Estadísticas: pacientes activos, coste estimado
- ✅ Botón "Activar suscripción" → Stripe Checkout
- ✅ Botón "Gestionar suscripción" (activas)
- ✅ Manejo de retorno checkout (success/cancel) con SweetAlert2
- ✅ Precio bloqueado para pioneros ⭐
- ✅ Skeleton loading

---

## 🔑 Variables de entorno necesarias

```bash
# Generar:
openssl rand -hex 64   # JWT_SECRET
openssl rand -hex 32   # ENCRYPTION_KEY
openssl rand -base64 16 # ADMIN_PASSWORD

# Obtener de servicios externos:
# DATABASE_URL → En producción: postgresql://coter:coter@postgres:5432/coter (contenedor local)
# SMTP_PASS → Resend API key
# STRIPE_SECRET_KEY → Stripe Dashboard (modo live)
# STRIPE_WEBHOOK_SECRET → Stripe Dashboard (webhook signing secret)
# STRIPE_PRICE_ID → Stripe Dashboard (price ID)
# FCM_SERVER_KEY → Firebase Console
```
