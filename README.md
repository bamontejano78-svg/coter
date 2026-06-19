# 🧠 Coter Pro

Plataforma terapéutica digital que conecta terapeutas con pacientes para seguimiento, tareas TCC y comunicación.

## 🚀 Stack

- **Backend**: Node.js + Express
- **Base de datos**: PostgreSQL
- **Frontend**: Vanilla HTML/CSS/JS (web + móvil vía Capacitor)
- **Infraestructura**: Docker + PM2

## 📋 Requisitos

- **Node.js** >= 18
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
| `DATABASE_URL` | URL de PostgreSQL | ✅ En producción |
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
- `POST /api/v1/therapists/login` — Login
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
│   ├── index.html      # App del paciente
│   └── therapist.html  # Panel del terapeuta
├── public/             # Archivos estáticos
├── logs/               # Logs (generados)
├── server.js           # Punto de entrada
├── database.js         # Pool PostgreSQL + migraciones + semillas
├── package.json        # Dependencias
├── Dockerfile          # Imagen Docker
├── docker-compose.yml  # Orquestación
├── ecosystem.config.js # Config PM2
├── .env.example        # Plantilla de variables
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

## 📱 Deploy

### Railway / Render
1. Conecta el repositorio
2. Configura las variables de entorno requeridas
3. La base de datos PostgreSQL se aprovisiona automáticamente

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
- Datos sensibles encriptados con AES-256-GCM
- Rate limiting en endpoints sensibles
- Helmet para headers de seguridad HTTP
- CORS configurable por entorno
- CSP (Content Security Policy) activo
- Pool de conexiones con timeouts

## 📄 Licencia

ISC
