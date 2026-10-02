// Tests de integración — 2FA TOTP del panel de administración (/admin)
// Ejecutar: npm run test:integration (requiere PostgreSQL de test)
//
// Nota: el runner inyecta ADMIN_PASSWORD vía cross-env para que config/env.js
// lo capture de forma determinista aunque el .env local no lo tenga.

require('../scripts/test-db-safety').prepareTestDatabase();
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const request = require('supertest');
const { getPool, initializeDatabase, closeDatabase } = require('../database');
const { totp } = require('../utils/totp');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/coter_test';
process.env.JWT_SECRET = 'test_secret_key_for_testing_1234567890';
process.env.ENCRYPTION_KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-admin-password-123456';

let app;
let pool;

function currentCode(secret) {
  return totp(secret, { time: Date.now() });
}

// Extrae las cookies Set-Cookie de una respuesta supertest como header 'Cookie'
function cookieHeader(res) {
  const setCookie = res.headers['set-cookie'];
  const arr = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  return arr.map(c => c.split(';')[0]).join('; ');
}

async function adminSession(password) {
  return request(app).post('/api/v1/admin/session').send({ password });
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('TESTS SOLO DEBEN EJECUTARSE CON NODE_ENV=test. Actual: ' + process.env.NODE_ENV);
  }

  await initializeDatabase();
  pool = getPool();

  // Limpiar tablas de admin y las que afectan a estos tests
  await pool.query('DELETE FROM admin_2fa_backup_codes');
  await pool.query('DELETE FROM admin_settings');
  await pool.query('DELETE FROM notifications');
  await pool.query('DELETE FROM task_templates WHERE therapist_id IS NOT NULL');
  await pool.query('DELETE FROM clinical_notes');
  await pool.query('DELETE FROM goals');
  await pool.query('DELETE FROM assignments');
  await pool.query('DELETE FROM messages');
  await pool.query('DELETE FROM check_ins');
  await pool.query('DELETE FROM therapist_patients');
  await pool.query('DELETE FROM connection_codes');
  await pool.query('DELETE FROM password_resets');
  await pool.query('DELETE FROM patients');
  await pool.query('DELETE FROM therapists');

  app = require('../server');
}, 30000);

beforeEach(async () => {
  // Cada test parte con el 2FA de admin desactivado para que el login
  // inicial devuelva una sesión real (los tests anteriores lo activan).
  await pool.query('DELETE FROM admin_2fa_backup_codes');
  await pool.query('DELETE FROM admin_settings');
});

afterAll(async () => {
  await closeDatabase();
});

describe('2FA del panel de administración', () => {
  test('login sin 2FA funciona y da acceso a /stats', async () => {
    const res = await adminSession(ADMIN_PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.requires_2fa).toBeUndefined();

    const cookie = cookieHeader(res);
    const stats = await request(app).get('/api/v1/admin/stats').set('Cookie', cookie);
    expect(stats.statusCode).toBe(200);
    expect(stats.body.success).toBe(true);
  });

  test('password incorrecta → 401', async () => {
    const res = await adminSession('password-incorrecta');
    expect(res.statusCode).toBe(401);
  });

  test('setup + confirm activa 2FA y status lo refleja', async () => {
    const login = await adminSession(ADMIN_PASSWORD);
    const cookie = cookieHeader(login);

    const statusBefore = await request(app).get('/api/v1/admin/2fa/status').set('Cookie', cookie);
    expect(statusBefore.statusCode).toBe(200);
    expect(statusBefore.body.enabled).toBe(false);

    const setup = await request(app).post('/api/v1/admin/2fa/setup').set('Cookie', cookie);
    expect(setup.statusCode).toBe(200);
    expect(setup.body.success).toBe(true);
    const { secret, otpauth_url: otpauth, qr_code_data_url: qr } = setup.body;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauth).toContain('otpauth://totp/');
    expect(qr).toContain('data:image/png;base64,');

    // Código incorrecto → 401
    const bad = await request(app).post('/api/v1/admin/2fa/confirm').set('Cookie', cookie).send({ code: '000000' });
    expect(bad.statusCode).toBe(401);

    // Código correcto → activa y devuelve respaldos
    const confirm = await request(app).post('/api/v1/admin/2fa/confirm').set('Cookie', cookie).send({ code: currentCode(secret) });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.body.success).toBe(true);
    expect(confirm.body.backup_codes).toHaveLength(10);

    const statusAfter = await request(app).get('/api/v1/admin/2fa/status').set('Cookie', cookie);
    expect(statusAfter.body.enabled).toBe(true);

    // Setup repetido → 409
    const again = await request(app).post('/api/v1/admin/2fa/setup').set('Cookie', cookie);
    expect(again.statusCode).toBe(409);
  });

  test('con 2FA activa, la contraseña sola no abre sesión', async () => {
    const login = await adminSession(ADMIN_PASSWORD);
    const cookie = cookieHeader(login);
    const setup = await request(app).post('/api/v1/admin/2fa/setup').set('Cookie', cookie);
    await request(app).post('/api/v1/admin/2fa/confirm').set('Cookie', cookie).send({ code: currentCode(setup.body.secret) });

    // Login → solo ticket pendiente, sin sesión real
    const res = await adminSession(ADMIN_PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.requires_2fa).toBe(true);

    const pendingCookie = cookieHeader(res);
    // El ticket pendiente NO vale para /stats
    const statsBlocked = await request(app).get('/api/v1/admin/stats').set('Cookie', pendingCookie);
    expect(statsBlocked.statusCode).toBe(401);

    // Sin ticket pendiente → 401
    const noTicket = await request(app).post('/api/v1/admin/verify-2fa').send({ code: currentCode(setup.body.secret) });
    expect(noTicket.statusCode).toBe(401);

    // Código incorrecto → 401
    const bad = await request(app).post('/api/v1/admin/verify-2fa').set('Cookie', pendingCookie).send({ code: '000000' });
    expect(bad.statusCode).toBe(401);

    // Código TOTP correcto → sesión real
    const ok = await request(app).post('/api/v1/admin/verify-2fa').set('Cookie', pendingCookie).send({ code: currentCode(setup.body.secret) });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.success).toBe(true);

    const sessionCookie = cookieHeader(ok);
    const stats = await request(app).get('/api/v1/admin/stats').set('Cookie', sessionCookie);
    expect(stats.statusCode).toBe(200);
  });

  test('código de respaldo permite entrar una sola vez', async () => {
    const login = await adminSession(ADMIN_PASSWORD);
    const cookie = cookieHeader(login);
    const setup = await request(app).post('/api/v1/admin/2fa/setup').set('Cookie', cookie);
    const confirm = await request(app).post('/api/v1/admin/2fa/confirm').set('Cookie', cookie).send({ code: currentCode(setup.body.secret) });
    const backupCode = confirm.body.backup_codes[0];

    const first = await adminSession(ADMIN_PASSWORD);
    const firstCookie = cookieHeader(first);
    const ok = await request(app).post('/api/v1/admin/verify-2fa').set('Cookie', firstCookie).send({ code: backupCode.toLowerCase() });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.success).toBe(true);

    const second = await adminSession(ADMIN_PASSWORD);
    const secondCookie = cookieHeader(second);
    const reused = await request(app).post('/api/v1/admin/verify-2fa').set('Cookie', secondCookie).send({ code: backupCode });
    expect(reused.statusCode).toBe(401);
  });

  test('disable exige código TOTP y vuelve al login de un paso', async () => {
    const login = await adminSession(ADMIN_PASSWORD);
    const cookie = cookieHeader(login);
    const setup = await request(app).post('/api/v1/admin/2fa/setup').set('Cookie', cookie);
    await request(app).post('/api/v1/admin/2fa/confirm').set('Cookie', cookie).send({ code: currentCode(setup.body.secret) });

    const bad = await request(app).post('/api/v1/admin/2fa/disable').set('Cookie', cookie).send({ code: '000000' });
    expect(bad.statusCode).toBe(401);

    const ok = await request(app).post('/api/v1/admin/2fa/disable').set('Cookie', cookie).send({ code: currentCode(setup.body.secret) });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.success).toBe(true);

    const res = await adminSession(ADMIN_PASSWORD);
    expect(res.body.success).toBe(true);
    expect(res.body.requires_2fa).toBeUndefined();
  });

  test('el secreto de 2FA se guarda cifrado en admin_settings', async () => {
    const login = await adminSession(ADMIN_PASSWORD);
    const cookie = cookieHeader(login);
    const setup = await request(app).post('/api/v1/admin/2fa/setup').set('Cookie', cookie);
    expect(setup.statusCode).toBe(200);

    const { rows } = await pool.query("SELECT value FROM admin_settings WHERE key = 'two_factor_secret'");
    expect(rows).toHaveLength(1);
    const stored = rows[0].value;
    expect(stored).toBeTruthy();
    expect(stored).not.toBe(setup.body.secret); // cifrado, no plaintext
    expect(stored.split(':')).toHaveLength(3); // iv:authTag:ciphertext
  });
});
