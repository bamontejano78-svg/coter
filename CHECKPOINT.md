# 🧠 Coter Pro — Checkpoint de Sesión

**Fecha:** 2026-07-27  
**Último commit:** `1fac13b`  
**Último tag:** `v2.6.0`  
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
| 🚀 **deploy-prod.sh** | Script de deploy con --init para SSL + Docker + migraciones |
| 📋 **.env.production** | Template de variables de entorno para producción |
| 🐳 **docker-compose.local.yml** | Override para deploy local sin SSL |

---

## 🐳 PRÓXIMO PASO: Deploy local con Docker Desktop

### 1. Instalar Docker Desktop

- Descargar: https://www.docker.com/products/docker-desktop/
- Instalar con opción **WSL 2**
- Reiniciar Windows
- Verificar que el icono esté verde 🟢

### 2. Verificar instalación

```bash
docker --version
docker compose version
```

### 3. Desplegar localmente

```bash
cd "D:\coter 4.0"

# Construir y levantar (API + PostgreSQL, sin nginx/SSL)
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

### 4. Verificar health

```bash
# Ver servicios
docker compose ps

# Health check (debe devolver {"status":"ok","database":"connected"})
curl http://localhost:3000/api/health
```

### 5. Acceder a la app

- Terapeuta: http://localhost:3000/terapeuta.html
- Paciente: http://localhost:3000/paciente.html
- Admin: http://localhost:3000/admin.html (password: `admin_local_dev`)

### 6. Comandos útiles

```bash
docker compose logs -f api     # Logs en tiempo real
docker compose restart api     # Reiniciar tras cambios
docker compose down            # Detener servicios
docker compose down -v         # Detener + borrar BD
```

---

## 🔜 Después del deploy local exitoso

1. **Probar flujo completo**: registrar terapeuta → generar código → conectar paciente → check-in → mensajes → tareas → exportar
2. **Verificar analytics**: dashboard con gráficos, period selector
3. **Si todo funciona**: ejecutar `./scripts/deploy-prod.sh --init` en el servidor real
4. **Configurar GitHub Secrets** si el deploy staging falla: `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`, `STAGING_DEPLOY_PATH`

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
| Billing | Stripe infraestructura lista, falta Checkout UI |
| SSL | nginx.conf listo para Let's Encrypt |

---

## 🔑 Variables de entorno necesarias para producción

```bash
# Generar secrets:
openssl rand -hex 64   # JWT_SECRET
openssl rand -hex 32   # ENCRYPTION_KEY
openssl rand -base64 16 # ADMIN_PASSWORD

# Obtener de servicios externos:
# DATABASE_URL → Neon / Railway / Supabase
# SMTP_PASS → Resend API key
# STRIPE_SECRET_KEY → Stripe Dashboard (modo live)
# FCM_SERVER_KEY → Firebase Console
```
