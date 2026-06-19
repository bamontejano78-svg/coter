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
const DB_POOL_MIN = parseInt(process.env.DB_POOL_MIN, 10) || 2;
const DB_POOL_MAX = parseInt(process.env.DB_POOL_MAX, 10) || 10;

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

// ─── Rate Limiting ──────────────────────────────────────────────
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000;
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX, 10) || 100;

// ─── Validación ─────────────────────────────────────────────────
const warnings = [];
const errors = [];

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
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
};
