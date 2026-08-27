# 🧠 Coter Pro

Plataforma terapéutica digital que conecta terapeutas con pacientes para seguimiento, tareas TCC y comunicación.

## 🚀 Stack

- **Backend**: Node.js + Express
- **Base de datos**: PostgreSQL
- **Frontend**: Vanilla HTML/CSS/JS (web + móvil vía Capacitor)
- **Infraestructura**: Render (Node.js nativo), o Docker + PM2 en VPS

## 📋 Requisitos

- **Node.js** >= 20 < 21
- **PostgreSQL** >= 14
- **npm** >= 9

## 🔧 Instalación

```bash
# 1. Clonar
git clone <repo-url>
cd coter

# 2. Instalar dependencias
npm install

# 3. Configurar variables de entorno
cp .env.example .env
# Edita .env con tus valores

# 4. Crear base de datos PostgreSQL
createdb coter
# O con Docker: docker run --name coter-db -e POSTGRES_DB=coter -e POSTGRES_PASSWORD=coter_dev -p 5432:5432 -d postgres:16-alpine

# 5. Iniciar (desarrollo)
npm run dev

# 6. Probar
curl http://localhost:3000/api/health
```

## 🐳 Docker

```bash
# Iniciar con PostgreSQL incluido
docker-compose up -d

# Ver logs
docker-compose logs -f api
```

## ⚙️ Variables de Entorno

| Variable | Descripción | Requerida |
|----------|-------------|-----------|
| `NODE_ENV` | Entorno: development / production / test | No (default: development) |
| `PORT` | Puerto del servidor | No (default: 3000) |
| `DATABASE_URL` | URL PostgreSQL para desarrollo/test; en Docker producción Compose la construye desde `DB_PASSWORD` | No en producción Docker |
| `JWT_SECRET` | Secreto para JWT | ✅ En producción |
| `ENCRYPTION_KEY` | 64 caracteres hex para AES-256 | ✅ En producción |
| `CORS_ORIGINS` | Orígenes permitidos (separados por coma) | ✅ En producción |
| `SMTP_HOST` | Servidor SMTP para emails | No |
| `SMTP_PORT` | Puerto SMTP | No (default: 587) |
| `SMTP_USER` | Usuario SMTP | No |
| `SMTP_PASS` | Contraseña SMTP | No |
| `APP_URL` | URL pública de la app | No |
| `LOG_LEVEL` | Nivel de log: debug / info / warn / error | No (default: info) |
| `DB_POOL_MIN` | Conexiones mínimas del pool | No (default: 2) |
| `DB_POOL_MAX` | Conexiones máximas del pool | No (default: 10) |

## 📡 API Endpoints

### Health
- `GET /api/health` — Estado del servidor y BD

### Terapeutas (API v1)
- `POST /api/v1/therapists/register` — Registro
- `POST /api/v1/therapists/login` — Login (si el terapeuta tiene 2FA activa devuelve `requires_2fa` + `two_factor_token`)
- `POST /api/v1/therapists/verify-2fa` — Segundo paso del login (código TOTP o código de respaldo)
- `GET /api/v1/therapists/2fa/status` — Estado de la verificación en dos pasos 🔒
- `POST /api/v1/therapists/2fa/setup` — Inicia configuración 2FA (devuelve secreto + QR) 🔒
- `POST /api/v1/therapists/2fa/confirm` — Confirma 2FA con un código TOTP (devuelve códigos de respaldo) 🔒
- `POST /api/v1/therapists/2fa/disable` — Desactiva 2FA (exige código TOTP actual) 🔒
- `POST /api/v1/therapists/password-recovery` — Recuperar contraseña
- `POST /api/v1/therapists/reset-password` — Resetear contraseña
- `GET /api/v1/therapists/dashboard` — Dashboard 🔒
- `GET /api/v1/therapists/patients` — Lista de pacientes 🔒
- `GET /api/v1/therapists/patients/:id` — Perfil de paciente 🔒
- `POST /api/v1/therapists/patients/:id/messages` — Enviar mensaje 🔒
- `POST /api/v1/therapists/patients/:id/assignments` — Asignar tarea 🔒
- `POST /api/v1/therapists/patients/:id/goals` — Crear objetivo 🔒
- `GET /api/v1/therapists/patients/:id/clinical-notes` — Notas clínicas 🔒
- `POST /api/v1/therapists/patients/:id/clinical-notes` — Crear nota 🔒
- `GET /api/v1/therapists/task-templates` — Biblioteca TCC 🔒
- `GET /api/v1/therapists/calendar?month=YYYY-MM` — Calendario 🔒
- `GET /api/v1/therapists/export/:patientId` — Exportar datos 🔒
- `POST /api/v1/therapists/refresh-token` — Refrescar access token
- `POST /api/v1/therapists/logout` — Cerrar sesión (revoca refresh tokens)

### Pacientes
- `POST /api/v1/patients/connect` — Conectar con código
- `GET /api/v1/patients/:id/export` — Exportar mis datos (RGPD, JSON descargable) 🔒
- `POST /api/v1/patients/:id/delete` — Borrar mis datos (RGPD, requiere confirmación `BORRAR`) 🔒
- `POST /api/v1/patients/:id/check-ins` — Enviar check-in
- `GET /api/v1/patients/:id/check-ins` — Ver check-ins
- `GET /api/v1/patients/:id/messages` — Ver mensajes
- `POST /api/v1/patients/:id/messages` — Enviar mensaje
- `GET /api/v1/patients/:id/assignments` — Ver tareas
- `PUT /api/v1/patients/:id/assignments/:aid` — Completar tarea
- `GET /api/v1/patients/:id/goals` — Ver objetivos
- `GET /api/v1/patients/:id/progress` — Ver progreso
- `GET /api/v1/patients/:id/notifications` — Notificaciones

> 🔒 = Requiere autenticación (Bearer Token)

## 🏗️ Estructura del Proyecto

```
coter/
├── config/             # Configuración
│   ├── env.js          # Validación de variables de entorno
│   └── logger.js       # Winston logger
├── middleware/         # Middleware Express
│   └── auth.js         # Autenticación JWT
├── routes/             # Rutas de la API
│   ├── therapist.js    # Endpoints del terapeuta
│   └── patients.js     # Endpoints del paciente
├── utils/              # Utilidades
│   ├── encryption.js   # Encriptación AES-256-GCM
│   └── notifications.js # Notificaciones y recordatorios
├── migrations/         # Migraciones SQL
│   └── 001_initial.sql # Migración inicial
├── tests/              # Tests
│   ├── api.test.js     # Tests de integración
│   └── encryption.test.js # Tests unitarios
├── www/                # Frontend (web + Capacitor)
│   ├── index.html      # Landing selectora (paciente / terapeuta)
│   ├── paciente.html   # App del paciente
│   ├── terapeuta.html  # Panel del terapeuta
│   ├── reset-password.html # Restablecer contraseña (terapeuta)
│   └── css/, js/, lib/ # Estilos, scripts y librerías
├── public/             # Archivos estáticos
├── logs/               # Logs (generados)
├── server.js           # Punto de entrada
├── database.js         # Pool PostgreSQL + migraciones + semillas
├── package.json        # Dependencias
├── Dockerfile          # Imagen Docker
├── docker-compose.yml  # Orquestación
├── ecosystem.config.js # Config PM2
├── .env.example        # Plantilla de variables
├── render.yaml         # Blueprint Render sin Docker
└── README.md
```

## 🧪 Tests

```bash
# Ejecutar tests
npm test

# Solo tests unitarios
npx jest tests/encryption.test.js

# Solo tests de API (requiere PostgreSQL)
npx jest tests/api.test.js
```

### QA visual opcional (requiere `playwright-core`)

Los scripts `scripts/qa-2fa.js` y `scripts/qa-gdpr.js` recorren los flujos
2FA y RGPD en Chrome real. Son opcionales y **no** forman parte de las
dependencias del proyecto; si quieres ejecutarlos, instala `playwright-core`
bajo demanda (usa el Chrome ya instalado, no descarga navegadores):

```bash
npm install --no-save playwright-core
node scripts/qa-2fa.js
node scripts/qa-gdpr.js
```

## 📱 Deploy sin Docker — Render

El archivo `render.yaml` define un Web Service de staging que ejecuta Node.js
directamente, sin Docker, Nginx ni Certbot local. Render proporciona HTTPS y
la variable `PORT` automáticamente.

1. Crea una base de datos PostgreSQL en Render y conserva su **Internal Database URL**.
2. Crea un Blueprint desde este repositorio y selecciona `render.yaml`.
3. Configura `DATABASE_URL` con esa URL interna (el Blueprint no crea la BD automáticamente). En PostgreSQL gestionado, deja TLS explicito con `sslmode=verify-full` si el proveedor no lo incluye ya.
4. Completa las variables `sync:false` en el dashboard de Render.
5. Pon la URL pública de Render en `APP_URL` y en `CORS_ORIGINS` (por ejemplo, `https://coter-staging.onrender.com`).
6. Configura en Stripe el webhook `https://<tu-servicio>.onrender.com/api/v1/billing/webhook`.
7. Valida staging con:
   - Preflight local/host: `npm run staging:preflight`
   - Readiness operativo: `npm run staging:readiness`
   - Smoke público: `STAGING_URL=https://<tu-servicio>.onrender.com npm run staging:smoke`
8. Usa estos comandos si creas el servicio manualmente:
   - Build: `npm ci --omit=dev`
   - Start: `npm start`
   - Health check: `/api/health`

La aplicación ejecuta las migraciones al arrancar y usa un advisory lock para
impedir migraciones concurrentes. No guardes secretos en `render.yaml` ni en Git.

> El plan gratuito es solo para staging/demo: puede dormir por inactividad. Al
> dormir, los jobs `node-cron` de recordatorios, billing y alertas no se ejecutan.
> No uses este plan para datos clínicos reales ni para notificaciones operativas.
> Para producción necesitas un servicio persistente, PostgreSQL con retención y
> backups adecuados, y un scheduler/cron fiable separado o un plan que no duerma.

### Estado de privacidad para producción

El backend cifra datos sensibles en reposo con AES-256-GCM, incluidas
conversaciones, check-ins, instrucciones, respuestas sensibles de ejercicios,
notas SOAP y resúmenes de sesiones clínicas. El E2EE híbrido definido para
datos clínicos compartidos todavía no está implementado. Antes de usar datos
clínicos reales, las notificaciones push deben mantenerse genéricas, no debe
persistirse PHI en almacenamiento web local y debe cerrarse la revisión legal
RGPD/LOPDGDD.

### VPS (PM2)
```bash
npm ci --production
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup
```

### Docker
```bash
docker-compose up -d
```

## 🔒 Seguridad

- Contraseñas hasheadas con bcrypt (10 rondas)
- Tokens JWT con expiración configurable
- **Verificación en dos pasos (2FA TOTP)** para terapeutas y para el panel de administración, compatible con Google Authenticator/Authy, con códigos de respaldo de un solo uso y secreto cifrado en reposo (AES-256-GCM)
- **Auditoría de acceso a fichas clínicas** (RGPD/LOPDGDD): cada consulta del terapeuta a una ficha, notas, sesiones o exportación queda registrada (quién, qué, cuándo, IP) y es consultable desde el panel admin; la traza sobrevive al borrado RGPD del paciente
- Datos sensibles encriptados con AES-256-GCM
- Rate limiting en endpoints sensibles
- Helmet para headers de seguridad HTTP
- CORS configurable por entorno
- CSP (Content Security Policy) activo
- Pool de conexiones con timeouts

## 📄 Licencia

ISC
