// En producción (Railway, etc.), las variables vienen del entorno real.
// Solo cargar dotenv-flow en desarrollo. En prod, process.env ya tiene los valores.
if (process.env.NODE_ENV !== 'production') {
  require('dotenv-flow').config({ silent: true });
}

const logger = require('./logger');

/**
 * Validación estricta de variables de entorno.
 * En producción, las variables deben estar definidas en el entorno
 * (no en .env). dotenv-flow carga .env solo en development.
 */

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';

// ─── Configuración del servidor ─────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ─── CORS ───────────────────────────────────────────────────────
const CORS_ORIGINS_RAW = process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || '';
const CORS_ORIGINS = CORS_ORIGINS_RAW
  ? CORS_ORIGINS_RAW.split(',').map(o => o.trim()).filter(Boolean)
  : (isProd ? [] : ['http://localhost:3000', 'http://localhost:8080', 'http://127.0.0.1:3000']);

// ─── Base de Datos ──────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL;
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
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || (isProd ? '7d' : '30d');
const REFRESH_TOKEN_DAYS = parseInt(process.env.REFRESH_TOKEN_DAYS, 10) || (isProd ? 30 : 90);

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
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX, 10) || 100;

// ─── Cron ───────────────────────────────────────────────────────
const CRON_REMINDERS = process.env.CRON_REMINDERS || null;
const CRON_BILLING = process.env.CRON_BILLING || null;

// ─── Stripe ──────────────────────────────────────────────────────
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || null;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || null;
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || null;

// ─── Firebase Cloud Messaging ────────────────────────────────────
const FCM_SERVER_KEY = process.env.FCM_SERVER_KEY || null;
const FCM_SENDER_ID = process.env.FCM_SENDER_ID || null;

const warnings = [];
const errors = [];

// Validar Stripe en producción (no bloqueante — Stripe es opcional en dev)
if (isProd && !STRIPE_SECRET_KEY) {
  warnings.push('⚠️  STRIPE_SECRET_KEY no configurado — los pagos no funcionarán');
}
if (isProd && !STRIPE_WEBHOOK_SECRET) {
  warnings.push('⚠️  STRIPE_WEBHOOK_SECRET no configurado — los webhooks no se verificarán');
}
if (isProd && !STRIPE_PRICE_ID) {
  warnings.push('⚠️  STRIPE_PRICE_ID no configurado — no se podrán crear sesiones de checkout');
}

// ─── Validación ─────────────────────────────────────────────────
if (!JWT_SECRET && isProd) {
  errors.push('JWT_SECRET es requerido en producción');
} else if (!JWT_SECRET && !isProd) {
  warnings.push('⚠️  JWT_SECRET no configurado — usando valor inseguro para desarrollo');
}

if (!ENCRYPTION_KEY && isProd) {
  errors.push('ENCRYPTION_KEY es requerido en producción');
} else if (!ENCRYPTION_KEY && !isProd) {
  warnings.push('⚠️  ENCRYPTION_KEY no configurada — datos sensibles NO serán encriptados');
}

if (ENCRYPTION_KEY && !/^[0-9a-fA-F]{64}$/.test(ENCRYPTION_KEY)) {
  errors.push('ENCRYPTION_KEY inválida — deben ser 64 caracteres hexadecimales (32 bytes)');
}

if (!DATABASE_URL && isProd) {
  errors.push('DATABASE_URL es requerido en producción');
} else if (!DATABASE_URL && !isProd) {
  warnings.push('⚠️  DATABASE_URL no configurada — se usará SQLite local como fallback');
}

if (isProd && CORS_ORIGINS.length === 0) {
  errors.push('CORS_ORIGINS es requerido en producción (ej: https://coter.app,https://app.coter.app)');
}

if (errors.length > 0) {
  const errorMsg = '❌ Errores de configuracion:\n   • ' + errors.join('\n   • ');
  logger.error(errorMsg);
  // En produccion o test, lanzar error para detener el arranque
  if (isProd || isTest) {
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
  PORT,
  HOST,
  CORS_ORIGINS,
  DATABASE_URL,
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
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  STRIPE_PRICE_ID,
  FCM_SERVER_KEY,
  FCM_SENDER_ID,
};
