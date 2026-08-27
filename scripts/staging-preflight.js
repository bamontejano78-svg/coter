'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : 'true'];
}));

const envFile = args.get('env-file') || process.env.STAGING_ENV_FILE || '.env.staging';
const envPath = path.resolve(ROOT, envFile);
const loadedEnvFile = fs.existsSync(envPath);

if (loadedEnvFile) {
  require('dotenv').config({ path: envPath, override: false, quiet: true });
}

process.env.NODE_ENV = process.env.NODE_ENV || 'staging';

// docker-compose.staging.yml builds DATABASE_URL inside the container. Synthesize
// the same shape here so config/env.js can validate the runtime contract.
if (!process.env.DATABASE_URL && process.env.DB_PASSWORD) {
  process.env.DATABASE_URL = `postgresql://coter:${encodeURIComponent(process.env.DB_PASSWORD)}@postgres:5432/coter_staging`;
}

const errors = [];
const warnings = [];
const required = [
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  'CORS_ORIGINS',
  'APP_URL',
  'ADMIN_PASSWORD',
  'SMTP_PASS',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_ID',
];

function isPlaceholder(value) {
  return !value || /REEMPLAZAR|xxxxxxxx|DO_NOT_USE|placeholder|admin_secreto|changeme/i.test(value);
}

function requireRealSecret(key) {
  if (isPlaceholder(process.env[key])) {
    errors.push(`${key} falta o sigue siendo placeholder`);
  }
}

function parseUrl(value, label) {
  try {
    return new URL(value);
  } catch (_err) {
    errors.push(`${label} no es una URL valida`);
    return null;
  }
}

function isLocalUrl(url) {
  return ['localhost', '127.0.0.1', '0.0.0.0', 'postgres'].includes(url.hostname);
}

function maskDatabaseUrl(value) {
  const url = parseUrl(value, 'DATABASE_URL');
  if (!url) return 'invalida';
  if (url.username) url.username = '***';
  if (url.password) url.password = '***';
  return url.toString();
}

if (!loadedEnvFile && !process.env.STAGING_PREFLIGHT_ALLOW_ENV_ONLY) {
  warnings.push(`No existe ${envFile}; usando solo variables del entorno`);
}

if (process.env.NODE_ENV !== 'staging') {
  errors.push(`NODE_ENV debe ser staging para este preflight, recibido: ${process.env.NODE_ENV}`);
}

required.forEach(requireRealSecret);

if (!process.env.DATABASE_URL && !process.env.DB_PASSWORD) {
  errors.push('DATABASE_URL o DB_PASSWORD es requerido');
}

const appUrl = process.env.APP_URL ? parseUrl(process.env.APP_URL, 'APP_URL') : null;
if (appUrl && appUrl.protocol !== 'https:' && !isLocalUrl(appUrl)) {
  errors.push('APP_URL debe usar HTTPS en staging real');
}

const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean);
if (corsOrigins.includes('*')) {
  errors.push('CORS_ORIGINS no puede incluir * en staging');
}
for (const origin of corsOrigins) {
  const parsed = parseUrl(origin, `CORS_ORIGINS (${origin})`);
  if (parsed && parsed.protocol !== 'https:' && !isLocalUrl(parsed)) {
    errors.push(`CORS_ORIGINS debe usar HTTPS para origen publico: ${origin}`);
  }
}

const databaseUrl = process.env.DATABASE_URL ? parseUrl(process.env.DATABASE_URL, 'DATABASE_URL') : null;
if (databaseUrl) {
  const host = databaseUrl.hostname;
  const managedTlsHost = /(neon\.tech|render\.com|railway\.app|supabase\.co)$/i.test(host);
  const sslmode = databaseUrl.searchParams.get('sslmode');
  if (managedTlsHost && sslmode !== 'verify-full') {
    errors.push('DATABASE_URL de proveedor gestionado debe incluir sslmode=verify-full');
  }
}

if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 64) {
  warnings.push('JWT_SECRET tiene menos de 64 caracteres; recomendado 64+ para staging');
}

if (process.env.STRIPE_SECRET_KEY && !/^sk_(test|live)_/.test(process.env.STRIPE_SECRET_KEY)) {
  errors.push('STRIPE_SECRET_KEY debe empezar por sk_test_ o sk_live_');
}

if (process.env.STRIPE_SECRET_KEY && /^sk_live_/.test(process.env.STRIPE_SECRET_KEY)) {
  warnings.push('STRIPE_SECRET_KEY parece live; staging deberia usar claves test salvo decision explicita');
}

if (!process.env.FCM_SERVER_KEY || !process.env.FCM_SENDER_ID) {
  warnings.push('FCM no configurado; push notifications no se validaran en staging');
}

if (process.env.API_IMAGE && /:(latest|main)$/i.test(process.env.API_IMAGE)) {
  warnings.push('API_IMAGE no es inmutable; para staging real usa SHA o digest');
}

try {
  require('../config/env');
} catch (err) {
  errors.push(err.message.replace(/\s+/g, ' ').trim());
}

console.log('Staging preflight');
console.log(`- env file: ${loadedEnvFile ? path.relative(ROOT, envPath) : 'no cargado'}`);
console.log(`- node env: ${process.env.NODE_ENV}`);
console.log(`- app url: ${process.env.APP_URL || 'no configurada'}`);
console.log(`- cors origins: ${corsOrigins.length}`);
console.log(`- database: ${process.env.DATABASE_URL ? maskDatabaseUrl(process.env.DATABASE_URL) : 'compose DB_PASSWORD'}`);

warnings.forEach((warning) => console.warn(`WARN: ${warning}`));

if (errors.length > 0) {
  console.error('\nPreflight fallido:');
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log('OK: configuracion de staging lista para arrancar');
