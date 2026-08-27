// En producción (Railway, etc.), las variables vienen del entorno real.
// Solo cargar .env en desarrollo/test. En prod, process.env ya tiene los valores.
// Las variables ya inyectadas por CI/Docker tienen prioridad sobre .env.
// En desarrollo/test se carga el archivo local sin sobrescribir el entorno real.
const injectedNodeEnv = process.env.NODE_ENV;
const loadsDotenv = !['production', 'staging'].includes(injectedNodeEnv);
if (loadsDotenv) {
  const savedNodeEnv = process.env.NODE_ENV;
  require('dotenv').config({ path: '.env', quiet: true });
  // Restore NODE_ENV set via command line (override:true would overwrite it from .env)
  if (savedNodeEnv) process.env.NODE_ENV = savedNodeEnv;
}

const logger = require('./logger');

/**
 * Validación estricta de variables de entorno.
 * En producción, las variables deben estar definidas en el entorno
 * (no en .env).
 */

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';
const isSecureDeployment = NODE_ENV === 'production' || NODE_ENV === 'staging';

// ─── Configuración del servidor ─────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ─── CORS ───────────────────────────────────────────────────────
const CORS_ORIGINS_RAW = process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || '';
const CORS_ORIGINS = CORS_ORIGINS_RAW
  ? CORS_ORIGINS_RAW.split(',').map(o => o.trim()).filter(Boolean)
  : (isSecureDeployment ? [] : ['http://localhost:3000', 'http://localhost:8080', 'http://127.0.0.1:3000']);

// ─── Base de Datos ──────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL;
function databaseSslMode(connectionString) {
  if (!connectionString) return null;
  try {
    return new URL(connectionString).searchParams.get('sslmode');
  } catch (_err) {
    return null;
  }
}
const DATABASE_SSLMODE = databaseSslMode(DATABASE_URL);
const DB_POOL_MIN_RAW = parseInt(process.env.DB_POOL_MIN, 10);
const DB_POOL_MAX_RAW = parseInt(process.env.DB_POOL_MAX, 10);
const DB_CONNECTION_TIMEOUT_MS_RAW = parseInt(process.env.DB_CONNECTION_TIMEOUT_MS, 10);
const DB_POOL_MIN = Number.isNaN(DB_POOL_MIN_RAW) ? (isTest ? 0 : 2) : DB_POOL_MIN_RAW;
const DB_POOL_MAX = Number.isNaN(DB_POOL_MAX_RAW) ? 10 : DB_POOL_MAX_RAW;
const DB_CONNECTION_TIMEOUT_MS = Number.isNaN(DB_CONNECTION_TIMEOUT_MS_RAW)
  ? (isTest ? 10000 : 15000)
  : DB_CONNECTION_TIMEOUT_MS_RAW;

// ─── JWT ────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || (isSecureDeployment ? '7d' : '30d');
const REFRESH_TOKEN_DAYS = parseInt(process.env.REFRESH_TOKEN_DAYS, 10) || (isSecureDeployment ? 30 : 90);

// ─── Encriptación ───────────────────────────────────────────────
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

// ─── Email (para recuperación de contraseña) ──────────────────
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10) || 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || 'noreply@coter.app';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const PIONEER_NOTIFY_EMAIL = process.env.PIONEER_NOTIFY_EMAIL || null;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;

// ─── Rate Limiting ──────────────────────────────────────────────
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000;
const RATE_LIMIT_MAX = isTest ? 10000 : (parseInt(process.env.RATE_LIMIT_MAX, 10) || 100);

// ─── Cron ───────────────────────────────────────────────────────
const CRON_REMINDERS = process.env.CRON_REMINDERS || null;
const CRON_BILLING = process.env.CRON_BILLING || null;
const CRON_ALERTS = process.env.CRON_ALERTS || null;

// ─── Stripe ──────────────────────────────────────────────────────
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || null;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || null;
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || null;

// ─── Firebase Cloud Messaging ────────────────────────────────────
const FCM_SERVER_KEY = process.env.FCM_SERVER_KEY || null;
const FCM_SENDER_ID = process.env.FCM_SENDER_ID || null;

const warnings = [];
const errors = [];
const isUnsetOrPlaceholder = (value) => !value || /REEMPLAZAR|xxxxxxxx|DO_NOT_USE|admin_secreto|re_123456/i.test(value);

// Validar Stripe en producción (no bloqueante — Stripe es opcional en dev)
if (isSecureDeployment && (isUnsetOrPlaceholder(STRIPE_SECRET_KEY) || (isProd && !/^sk_live_/.test(STRIPE_SECRET_KEY)))) {
  errors.push('STRIPE_SECRET_KEY es requerido y debe ser una clave live en producción');
}
if (isSecureDeployment && (isUnsetOrPlaceholder(STRIPE_WEBHOOK_SECRET) || !/^whsec_/.test(STRIPE_WEBHOOK_SECRET))) {
  errors.push('STRIPE_WEBHOOK_SECRET es requerido y debe tener formato whsec_');
}
if (isSecureDeployment && (isUnsetOrPlaceholder(STRIPE_PRICE_ID) || !/^price_/.test(STRIPE_PRICE_ID))) {
  errors.push('STRIPE_PRICE_ID es requerido y debe tener formato price_');
}
if (isSecureDeployment && (isUnsetOrPlaceholder(process.env.ADMIN_PASSWORD) || process.env.ADMIN_PASSWORD.length < 16)) {
  errors.push('ADMIN_PASSWORD es requerido y debe ser real en despliegues seguros');
}
if (isSecureDeployment && isUnsetOrPlaceholder(SMTP_PASS)) {
  errors.push('SMTP_PASS es requerido y debe ser real para recuperación de contraseña');
}

// ─── Validación ─────────────────────────────────────────────────
if ((!JWT_SECRET || JWT_SECRET.length < 32 || /DO_NOT_USE|REEMPLAZAR/i.test(JWT_SECRET)) && isSecureDeployment) {
  errors.push('JWT_SECRET es requerido y debe tener al menos 32 caracteres en despliegues seguros');
} else if (!JWT_SECRET && !isSecureDeployment) {
  warnings.push('⚠️  JWT_SECRET no configurado — usando valor inseguro para desarrollo');
}

if (!ENCRYPTION_KEY && isSecureDeployment) {
  errors.push('ENCRYPTION_KEY es requerido en producción');
} else if (!ENCRYPTION_KEY && !isSecureDeployment) {
  warnings.push('⚠️  ENCRYPTION_KEY no configurada — datos sensibles NO serán encriptados');
}

if (ENCRYPTION_KEY && !/^[0-9a-fA-F]{64}$/.test(ENCRYPTION_KEY)) {
  errors.push('ENCRYPTION_KEY inválida — deben ser 64 caracteres hexadecimales (32 bytes)');
}

if (!DATABASE_URL && isSecureDeployment) {
  errors.push('DATABASE_URL es requerido en producción');
} else if (!DATABASE_URL && !isSecureDeployment) {
  warnings.push('⚠️  DATABASE_URL no configurada — se usará SQLite local como fallback');
}
if (isSecureDeployment && DATABASE_SSLMODE && /^(prefer|require|verify-ca)$/i.test(DATABASE_SSLMODE)) {
  errors.push('DATABASE_URL debe usar sslmode=verify-full en despliegues seguros');
}

if (isSecureDeployment && CORS_ORIGINS.length === 0) {
  errors.push('CORS_ORIGINS es requerido en producción (ej: https://coter.app,https://app.coter.app)');
}

if (errors.length > 0) {
  const errorMsg = '❌ Errores de configuracion:\n   • ' + errors.join('\n   • ');
  logger.error(errorMsg);
  // En produccion o test, lanzar error para detener el arranque
  if (isSecureDeployment || isTest) {
    throw new Error(errorMsg);
  }
}

if (warnings.length > 0 && !isTest) {
  warnings.forEach(w => logger.warn(w));
}

// ─── Exportar ───────────────────────────────────────────────────
module.exports = {
  NODE_ENV,
  isProd,
  isTest,
  isSecureDeployment,
  PORT,
  HOST,
  CORS_ORIGINS,
  DATABASE_URL,
  DATABASE_SSLMODE,
  DB_POOL_MIN,
  DB_POOL_MAX,
  DB_CONNECTION_TIMEOUT_MS,
  JWT_SECRET: JWT_SECRET || 'coter_dev_secret_DO_NOT_USE_IN_PRODUCTION',
  JWT_EXPIRES_IN,
  REFRESH_TOKEN_DAYS,
  ENCRYPTION_KEY,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
  APP_URL,
  PIONEER_NOTIFY_EMAIL,
  ADMIN_PASSWORD,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
  CRON_REMINDERS,
  CRON_BILLING,
  CRON_ALERTS,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  STRIPE_PRICE_ID,
  FCM_SERVER_KEY,
  FCM_SENDER_ID,
};
