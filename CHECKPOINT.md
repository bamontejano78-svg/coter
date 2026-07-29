# 🧠 Coter Pro — Checkpoint de Sesión

**Fecha:** 2026-07-28  
**Último commit:** `main`  
**Branch:** `main`  
**Tests:** 295/295 ✅

---

## 📦 Lo implementado esta sesión

| Feature | Archivos |
|---------|----------|
| 📊 **Analytics Dashboard** | `routes/therapist.js`, `www/terapeuta.html`, `www/js/therapist.js`, `www/css/therapist.css` |
| 📄 **Export PDF/CSV** | `routes/therapist.js` (generateHTMLReport, generateCSV), `www/js/therapist.js` (exportPatientData) |
| 🔔 **FCM Push P→T** | `utils/fcm.js` (sendToTherapist), `routes/therapist.js` (POST /push-token), `routes/patients.js`, `migrations/016` |
| 📅 **Clinical Sessions** | `routes/therapist.js` (CRUD), `www/terapeuta.html`, `www/js/therapist.js`, `migrations/015` |
| 🔧 **Billing Test Fix** | `middleware/billing.js` (BILLING_TEST_MODE), `tests/billing.test.js` |
| 🎯 **Session Selector** | `www/js/therapist.js` (showAddNote dropdown) |
| 📖 **DEPLOY.md** | Guía completa de despliegue a producción |
| 🚀 **deploy-prod.sh** | Script de deploy con --init para SSL + migraciones |
| 📋 **.env.example** | Template de variables de entorno para desarrollo |
| 🐳 **docker-compose.local.yml** | Override para deploy local sin SSL |
| 💳 **Stripe Checkout UI** | `www/js/therapist-billing.js`, `www/terapeuta.html`, `www/css/therapist.css` |

---

## 🗄️ PRÓXIMO PASO: Conexión PostgreSQL directa (Neon)

> **No se usa Docker.** La app se conecta directamente a PostgreSQL (Neon serverless).

### 1. Instalar dependencias

```bash
cd "D:\coter 4.0"
npm install
```

### 2. Configurar `.env`

Copiar de `.env.example` y completar con los valores reales:

```bash
copy .env.example .env
# Editar .env con las credenciales reales
```

Variables mínimas necesarias:
- `DATABASE_URL` — URL de Neon (ya disponible en `neon.txt`)
- `JWT_SECRET` — generar con `openssl rand -hex 64`
- `ENCRYPTION_KEY` — generar con `openssl rand -hex 32`
- `ADMIN_PASSWORD` — contraseña para el panel admin
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` — credenciales de email

### 3. Arrancar en desarrollo

```bash
npm run dev
```

### 4. Verificar health check

```bash
curl http://localhost:3000/api/health
# Debe devolver: {"status":"ok","database":"connected"}
```

### 5. Ejecutar tests

```bash
npm test
```

### 6. Acceder a la app

- Terapeuta: http://localhost:3000/terapeuta.html
- Paciente: http://localhost:3000/paciente.html
- Admin: http://localhost:3000/admin.html

---

## 🔜 Pendiente post-setup

1. **Probar flujo completo**: registrar terapeuta → generar código → conectar paciente → check-in → mensajes → tareas → exportar
2. **Verificar Stripe Checkout UI**: pestaña Facturación → botón "Activar suscripción" → checkout de Stripe
3. **Verificar analytics**: dashboard con gráficos, period selector
4. **Si todo funciona**: ejecutar `./scripts/deploy-prod.sh --init` en el servidor real
5. **Configurar GitHub Secrets** si el deploy staging falla: `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`, `STAGING_DEPLOY_PATH`

---

## 📊 Estado del proyecto

| Área | Estado |
|------|--------|
| Tests | 295/295 ✅ |
| CI/CD | GitHub Actions (test → build → scan → push → deploy) |
| GHCR | `ghcr.io/bamontejano78-svg/coter:v2.6.0` |
| Migraciones | 16 aplicadas (001 → 016) |
| Frontend | Terapeuta + Paciente + Admin + Landing |
| Widgets | 9 widgets interactivos (3 categorías) |
| Push notifications | Paciente ← → Terapeuta (FCM) |
| Billing | Stripe infraestructura + Checkout UI ✅ |
| SSL | nginx.conf listo para Let's Encrypt |

---

## 🔑 Variables de entorno necesarias para producción

```bash
# Generar secrets:
openssl rand -hex 64   # JWT_SECRET
openssl rand -hex 32   # ENCRYPTION_KEY
openssl rand -base64 16 # ADMIN_PASSWORD

# Obtener de servicios externos:
# DATABASE_URL → Neon (serverless Postgres)
# SMTP_PASS → Resend API key
# STRIPE_SECRET_KEY → Stripe Dashboard (modo live)
# STRIPE_WEBHOOK_SECRET → Stripe Dashboard (webhook signing secret)
# STRIPE_PRICE_ID → Stripe Dashboard (price ID del producto)
# FCM_SERVER_KEY → Firebase Console
```

## 💳 Stripe Checkout UI — Implementado

La UI de facturación ya está implementada:
- **Frontend:** `www/js/therapist-billing.js` — módulo autocontenido que se engancha al tab "Facturación"
- **Estilos:** `www/css/therapist.css` — clases `.billing-*`
- **HTML:** `www/terapeuta.html` — tab `#tab-billing` con skeleton loading
- **Backend:** `routes/billing.js` — endpoints `/status`, `/usage`, `/create-checkout`, `/webhook`

### Funcionalidades:
- ✅ Muestra estado de suscripción (trial, active, past_due, canceled)
- ✅ Barra de progreso del trial con días restantes
- ✅ Estadísticas: pacientes activos, coste estimado mensual
- ✅ Botón "Activar suscripción" → redirige a Stripe Checkout
- ✅ Botón "Gestionar suscripción" para suscripciones activas
- ✅ Manejo de retorno de checkout (success/cancel) con SweetAlert2
- ✅ Precio bloqueado para pioneros
- ✅ Skeleton loading mientras carga
