# 🧠 Coter Pro — Checkpoint de Sesión

**Fecha:** 2026-08-11
**Branch:** `main`
**Último commit conocido:** `7fc50b6` — `docs: checkpoint de sesion — sesion completa, pendiente instalar Docker`

> Este documento resume el estado real al cerrar la sesión. No contiene credenciales ni valores secretos.

---

## 🆕 Decisiones de esta sesión — coste cero y privacidad

### Objetivo de despliegue inicial

Hasta conseguir los primeros clientes, el objetivo es mantener **coste fijo cero**. No se recomienda activar Firebase Blaze, Cloud Run ni Cloud SQL en esta fase porque requieren facturación vinculada y pueden generar cargos fuera de la capa gratuita.

Arquitectura inicial propuesta:

```text
Render Free  → API Node.js/Express + frontend estático
Neon Free    → PostgreSQL
FCM          → Notificaciones push
Stripe       → Pagos, sin cuota mensual; cobra por transacción
```

El archivo `render.yaml` ya contiene una configuración de servicio `plan: free`. Esta estrategia tiene limitaciones: suspensión por inactividad, cold starts, cuotas reducidas, ausencia de SLA y posible suspensión de la base de datos gratuita. No debe usarse para datos clínicos reales sin una revisión adicional de privacidad, ubicación de datos y contratos de tratamiento.

Firebase puede usarse para FCM y, opcionalmente, para servir el frontend con Hosting Spark, pero no ejecutará el backend Express en el plan gratuito. No migrar PostgreSQL a Firestore: el proyecto depende de relaciones, transacciones, bloqueos y migraciones SQL.

### Decisión de privacidad

Se eligió una arquitectura **híbrida E2EE (cifrado de extremo a extremo)**, no un modelo local-only:

- Paciente y terapeuta deben poder compartir mensajes, tareas y evolución.
- El servidor debe funcionar progresivamente como relé de blobs cifrados.
- Las claves de descifrado no deben estar disponibles para el servidor.
- Los datos clínicos descifrados deben permanecer el menor tiempo posible en el dispositivo.
- `localStorage`, `sessionStorage`, URLs, logs, Cache Storage y notificaciones push no deben contener PHI/datos clínicos.
- Para persistencia local se prevé `IndexedDB` cifrado con Web Crypto en PWA y almacenamiento seguro nativo/SQLite cifrado en Android.

**Alcance inicial elegido:** proteger primero **notas clínicas SOAP y mensajes**. Todavía no se ha implementado esta migración.

### Riesgos aceptados y controles pendientes

- E2EE complica recuperación, acceso multidispositivo, exportaciones y analíticas.
- La pérdida de la clave de recuperación puede hacer los datos irrecuperables.
- Las métricas clínicas deberán calcularse localmente o basarse en datos agregados minimizados.
- Las notificaciones push deben ser genéricas y nunca incluir contenido clínico.
- Antes del uso con pacientes reales se necesita recuperación cifrada, rotación/revocación de dispositivos, backups cifrados y prueba de restauración.
- Durante el piloto gratuito se recomienda usar datos ficticios o anonimizados.
- Si se opera en España/UE, revisar RGPD/LOPDGDD, EIPD, base jurídica, contrato de encargado, retención, derechos y procedimiento de brechas con asesoría legal.

### Trabajo técnico recomendado para la próxima sesión

1. Auditar y clasificar cada campo sensible de mensajes y notas SOAP.
2. Eliminar contenido clínico de almacenamiento web y cachés existentes.
3. Crear una capa pequeña de IndexedDB cifrado para borradores locales, sin romper el backend actual.
4. Definir el formato versionado de ciphertext, nonce, auth tag y metadatos mínimos.
5. Diseñar la gestión de claves por dispositivo y recuperación antes de cifrar datos compartidos.
6. Añadir tests de round-trip, aislamiento entre usuarios, logout, pérdida de clave y migración.
7. Después, migrar mensajes y notas a sincronización de blobs cifrados.

**Importante:** en esta sesión no se modificó código de la arquitectura E2EE ni se migraron datos. Solo se tomaron decisiones de diseño y despliegue.

---

## ✅ Trabajo completado en esta sesión

### Hardening de producción

- Build de Nginx de producción corregido para usar `nginx/nginx.conf`.
- Imagen de staging separada mediante `nginx/Dockerfile.staging`.
- Certificados privados de staging no se copian a la imagen de producción; staging genera un certificado efímero durante el build.
- Zonas `limit_req` de Nginx separadas en `nginx/limits.conf`.
- PostgreSQL no se publica en puertos del host en Compose.
- Compose de producción y staging exige variables críticas en vez de usar defaults inseguros.
- `API_IMAGE` configurada para desplegar imágenes GHCR sin reconstrucción local en producción.
- Script de producción alineado con `DB_PASSWORD`, Compose y la imagen publicada; el health check se ejecuta dentro del contenedor.
- Script de staging local construye también Nginx cuando es necesario y queda limitado al host local.
- CI/CD deja de simular un deploy: valida secrets SSH, despliega staging por SSH y ejecuta smoke test de `/api/health`.
- CI construye staging con `--build` para soportar hosts limpios.
- YAML de Compose y GitHub Actions validado correctamente.

### Autenticación y secretos

- Panel admin migrado desde contraseña persistida en `sessionStorage` a cookie de sesión firmada, `HttpOnly`, `SameSite=Strict` y TTL corto.
- La contraseña admin solo viaja al endpoint `POST /api/v1/admin/session`.
- Añadido rate limiting específico para login admin.
- Scripts inline de admin y pioneros extraídos a:
  - `www/js/admin.js`
  - `www/js/pioneros.js`
- CSP de Helmet deja de bloquear el JavaScript del panel admin.
- Eliminadas credenciales demo del formulario del terapeuta.
- Eliminada la creación automática de la cuenta demo y su código conocido al arrancar.
- Eliminados de logs los tokens y URLs de recuperación de contraseña.
- Tokens de recuperación ahora se guardan como hash SHA-256; el token en claro solo se entrega por email o en el flujo explícito de desarrollo.
- `.env.example` sustituido por placeholders no operativos.
- Producción/staging rechazan secretos ausentes, placeholders, JWT débiles, contraseñas admin cortas y claves Stripe de prueba en producción.

### Billing y webhooks

- `billingGuard` cambiado a **fail-closed**: si no se puede verificar la suscripción devuelve `503`.
- `claimStripeEvent` ya no procesa eventos sin `event.id`.
- Idempotencia Stripe endurecida con estado `processing`/`processed` y recuperación de eventos atascados después de cinco minutos.
- Nueva migración `017_stripe_webhook_processing.sql`, incluida en la release.
- Procesamiento del webhook, actualización de suscripción, registro de eventos y marcado como procesado ejecutados dentro de una transacción PostgreSQL.
- Los fallos devuelven `5xx` para permitir reintentos de Stripe.

### Base de datos y migraciones

- Runner de migraciones usa `pg_advisory_lock` sobre una conexión dedicada.
- Migraciones y registro en `_migrations` se ejecutan en una transacción por archivo.
- Se añadió rollback ante errores.
- La migración 016 dejó de gestionar su propio `BEGIN/COMMIT` para no romper la atomicidad del runner.
- La cuenta demo ya no se crea en entornos de desarrollo automáticamente; las plantillas TCC sí se conservan como seed local.

### Cambios previos conservados

- Autorización multi-tenant y helper `utils/authorization.js`.
- Transacciones PostgreSQL para conexión y finalización de ejercicios/widgets.
- Bloqueos `FOR UPDATE` para límites de uso.
- Widgets limitados a asignaciones `classic`.
- Respuestas de widgets cifradas.
- Historial clínico conservado después de desconectar pacientes.
- Renovación UI/UX del dashboard, privacidad, accesibilidad y flujo móvil.
- Tokens temporales del terapeuta en `sessionStorage`, con identidad separada.
- Dependencias actualizadas: `dotenv`, `uuid` v11 y lockfile reparado.
- `neon.txt` eliminado del working tree.

---

## 🧪 Validación confirmada

Última ejecución completa después de los cambios de hardening:

- `npm run check:syntax`: ✅
- `npm audit --omit=dev --audit-level=high`: **0 vulnerabilidades** ✅
- `npm run test:unit`: **118/118** ✅
- `npm run test:integration`: **182/182** ✅
- `git diff --check`: ✅
- Parseo YAML de `.github/workflows/ci.yml`, `docker-compose.yml` y `docker-compose.staging.yml`: ✅
- Base de datos de integración: accesible durante la última ejecución ✅

> No volver a usar los conteos antiguos 115/115, 180/180 o 295/295 como estado actual; la referencia válida es 118/118 + 182/182.

---

## 📌 Estado Git al cierre

Existen modificaciones no confirmadas de sesiones anteriores y de esta sesión. No revertirlas automáticamente.

Archivos relevantes de la hardening actual:

```text
M  .env.example
M  .github/workflows/ci.yml
M  CHECKPOINT.md
M  DEPLOY.md
M  config/env.js
M  database.js
M  docker-compose.local.yml
M  docker-compose.staging.yml
M  docker-compose.yml
M  middleware/billing.js
M  migrations/016_therapist_push_tokens.sql
M  nginx.conf
M  nginx/Dockerfile
M  nginx/nginx.conf
M  nginx/nginx.staging.conf
M  routes/admin.js
M  routes/billing.js
M  routes/therapist.js
M  scripts/deploy-prod.sh
M  scripts/deploy-staging-local.sh
M  server.js
M  utils/billing.js
M  www/admin.html
M  www/pioneros.html
M  www/terapeuta.html
D  neon.txt
?? migrations/017_stripe_webhook_processing.sql
?? nginx/Dockerfile.staging
?? nginx/limits.conf
?? www/js/admin.js
?? www/js/pioneros.js
```

También permanecen cambios anteriores no relacionados directamente con esta sesión, `output/`, `tests/configSecurity.test.js` y `utils/authorization.js`. Revisar el diff por grupos antes de confirmar cambios.

La clave `nginx/certs/staging.key` está cubierta por `.gitignore` y no debe añadirse al repositorio.

---

## 🚫 Bloqueos externos pendientes

### Docker y staging

Docker Desktop/Docker Compose no estaban disponibles en esta máquina durante la sesión. No se pudo ejecutar un build real ni levantar staging local.

Después de instalar Docker Desktop con WSL2:

```bash
docker --version
docker compose version
```

Configurar un `.env` de staging fuera de Git con secretos reales y ejecutar:

```bash
bash scripts/deploy-staging-local.sh
```

Verificar:

```bash
curl https://localhost/api/health
docker compose -f docker-compose.staging.yml ps
docker compose -f docker-compose.staging.yml logs --tail=100 api
docker compose -f docker-compose.staging.yml logs --tail=100 nginx
```

### Credenciales y proveedores

Debe hacerse manualmente, fuera del chat y fuera del repositorio:

1. Rotar la credencial de Neon si fue expuesta.
2. Rotar Stripe y usar claves `live` únicamente en producción.
3. Rotar Firebase/FCM y SMTP si estuvieron expuestos.
4. Regenerar `JWT_SECRET` si se considera comprometido; esto invalida sesiones.
5. No cambiar `ENCRYPTION_KEY` sin migración/re-encriptado planificado.
6. Revisar y limpiar el secreto del historial Git si corresponde, con backup y autorización explícita; no hacer force-push automáticamente.

### Infraestructura operativa

Pendiente configurar y verificar:

- DNS para los dominios públicos.
- Certificados Let's Encrypt en el host de producción.
- Secrets SSH de staging en GitHub Actions.
- `STAGING_URL` para el smoke test.
- Backups automáticos cifrados y almacenamiento externo.
- Restauración real de un backup.
- Procedimiento de rollback probado.
- Monitorización, alertas y retención de logs.
- Revisión legal/compliance para datos clínicos y salud mental.

---

## ▶️ Orden recomendado para la próxima sesión

### 1. Revisar estado y diff

```bash
git status --short
git diff --stat
git diff --check
git diff -- .env.example config/env.js docker-compose.yml docker-compose.staging.yml
```

Separar mentalmente cambios previos de los cambios de producción de esta sesión. No borrar ni revertir archivos sin revisar su origen.

### 2. Repetir validación local

```bash
npm run check:syntax
npm run audit:prod
npm run test:unit
npm run test:integration
```

### 3. Instalar Docker y validar imágenes

```bash
docker compose -f docker-compose.yml config
docker compose -f docker-compose.staging.yml config
DOCKER_BUILDKIT=1 docker build -t coter-api:local .
DOCKER_BUILDKIT=1 docker build -f nginx/Dockerfile -t coter-nginx:production nginx
docker build -f nginx/Dockerfile.staging -t coter-nginx:staging nginx
```

No publicar imágenes ni desplegar producción sin autorización explícita.

### 4. Levantar staging con secretos fuera de Git

```bash
bash scripts/deploy-staging-local.sh
curl https://localhost/api/health
docker compose -f docker-compose.staging.yml ps
```

Probar: login, registro, recuperación, conexión paciente-terapeuta, check-in, mensajes, tareas, widgets, sesiones clínicas, privacidad y billing.

### 5. Configurar CI/CD remoto

Crear de forma segura los secrets:

```text
SSH_HOST
SSH_USER
SSH_PRIVATE_KEY
SSH_PORT (opcional)
STAGING_DEPLOY_PATH
STAGING_URL
```

Ejecutar un push controlado a `main` y verificar deploy + smoke test, sin exponer secretos en logs.

### 6. Backup, rollback y QA visual

- Ejecutar backup real con `scripts/backup.sh`.
- Restaurarlo en una base de datos aislada.
- Probar rollback a una imagen/tag anterior.
- QA en Chrome desktop y móvil:
  - `/`
  - `/paciente.html`
  - `/terapeuta.html`
  - `/admin.html`
  - `/pioneros.html`
- Confirmar ausencia de errores de consola y overflow horizontal.

---

## 🎯 Criterio de salida a producción

No hacer go-live hasta cumplir todo lo siguiente:

- Sintaxis y tests verdes después del último cambio.
- Auditoría de dependencias sin vulnerabilidades altas/críticas.
- Build real de API y Nginx validado (pendiente ejecutar en un host con Docker).
- Staging levantado y probado con configuración equivalente a producción (pendiente ejecutar en un host con Docker).
- Smoke test remoto funcionando en CI.
- Secretos reales configurados fuera de Git y credenciales históricas rotadas.
- Backup y restauración comprobados (pendiente ejecutar en infraestructura real).
- Rollback documentado y probado (pendiente ejecutar en infraestructura real).
- Certificados, DNS y proxy verificados.
- QA visual y accesibilidad completados.
- Revisión de privacidad, consentimiento, retención y cumplimiento legal completada.

**Estado actual:** preproducción avanzada; código endurecido y tests verdes, pero todavía no autorizado para go-live hasta completar infraestructura, secretos, backups, staging y QA externo.
