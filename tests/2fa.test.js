// Tests de integración — Verificación en dos pasos (2FA TOTP) del terapeuta
// Ejecutar: npm run test:integration (requiere PostgreSQL de test)

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { getPool, initializeDatabase, closeDatabase } = require('../database');
const { totp, generateSecret } = require('../utils/totp');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/coter_test';
process.env.JWT_SECRET = 'test_secret_key_for_testing_1234567890';
process.env.ENCRYPTION_KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

let app;
let pool;

async function registerTherapist() {
  const email = '2fa-' + uuidv4() + '@coter.com';
  const res = await request(app)
    .post('/api/v1/therapists/register')
    .send({ name: 'Terapeuta 2FA', email, specialty: 'psicologia', password: '123456' });
  expect(res.statusCode).toBe(200);
  expect(res.body.success).toBe(true);
  return { email, password: '123456', token: res.body.token, therapist: res.body.therapist };
}

async function login(email, password) {
  return request(app)
    .post('/api/v1/therapists/login')
    .send({ email, password });
}

function currentCode(secret) {
  return totp(secret, { time: Date.now() });
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('TESTS SOLO DEBEN EJECUTARSE CON NODE_ENV=test. Actual: ' + process.env.NODE_ENV);
  }

  await initializeDatabase();
  pool = getPool();

  // Limpiar tablas que afectan estos tests
  await pool.query('DELETE FROM therapist_2fa_backup_codes');
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

afterAll(async () => {
  await closeDatabase();
});

describe('2FA TOTP para terapeutas', () => {
  test('login sin 2FA funciona como antes', async () => {
    const { email, password } = await registerTherapist();
    const res = await login(email, password);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.requires_2fa).toBeUndefined();
    expect(res.body.token).toBeTruthy();
  });

  test('status devuelve desactivada por defecto', async () => {
    const { token } = await registerTherapist();
    const res = await request(app)
      .get('/api/v1/therapists/2fa/status')
      .set('Authorization', 'Bearer ' + token);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.enabled).toBe(false);
  });

  test('setup genera secreto y QR, confirm con TOTP activa 2FA', async () => {
    const { token } = await registerTherapist();

    const setupRes = await request(app)
      .post('/api/v1/therapists/2fa/setup')
      .set('Authorization', 'Bearer ' + token);
    expect(setupRes.statusCode).toBe(200);
    expect(setupRes.body.success).toBe(true);
    const { secret, otpauth_url: otpauth, qr_code_data_url: qr } = setupRes.body;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauth).toContain('otpauth://totp/');
    expect(qr).toContain('data:image/png;base64,');

    // Código incorrecto → 401
    const badConfirm = await request(app)
      .post('/api/v1/therapists/2fa/confirm')
      .set('Authorization', 'Bearer ' + token)
      .send({ code: '000000' });
    expect(badConfirm.statusCode).toBe(401);

    // Código correcto → activa y devuelve códigos de respaldo
    const confirmRes = await request(app)
      .post('/api/v1/therapists/2fa/confirm')
      .set('Authorization', 'Bearer ' + token)
      .send({ code: currentCode(secret) });
    expect(confirmRes.statusCode).toBe(200);
    expect(confirmRes.body.success).toBe(true);
    expect(confirmRes.body.backup_codes).toHaveLength(10);

    // Setup repetido → 409
    const again = await request(app)
      .post('/api/v1/therapists/2fa/setup')
      .set('Authorization', 'Bearer ' + token);
    expect(again.statusCode).toBe(409);
  });

  test('login con 2FA activa exige el segundo paso', async () => {
    const { email, password, token } = await registerTherapist();

    const setupRes = await request(app)
      .post('/api/v1/therapists/2fa/setup')
      .set('Authorization', 'Bearer ' + token);
    const secret = setupRes.body.secret;
    await request(app)
      .post('/api/v1/therapists/2fa/confirm')
      .set('Authorization', 'Bearer ' + token)
      .send({ code: currentCode(secret) });

    // Login con contraseña sola → requires_2fa, sin tokens
    const loginRes = await login(email, password);
    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.body.requires_2fa).toBe(true);
    expect(loginRes.body.two_factor_token).toBeTruthy();
    expect(loginRes.body.token).toBeUndefined();
    expect(loginRes.body.refresh_token).toBeUndefined();

    // Código incorrecto → 401
    const bad = await request(app)
      .post('/api/v1/therapists/verify-2fa')
      .send({ two_factor_token: loginRes.body.two_factor_token, code: '000000' });
    expect(bad.statusCode).toBe(401);

    // Código TOTP correcto → tokens de sesión
    const ok = await request(app)
      .post('/api/v1/therapists/verify-2fa')
      .send({ two_factor_token: loginRes.body.two_factor_token, code: currentCode(secret) });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.success).toBe(true);
    expect(ok.body.token).toBeTruthy();
    expect(ok.body.refresh_token).toBeTruthy();

    // El token funciona en una ruta protegida
    const statusRes = await request(app)
      .get('/api/v1/therapists/2fa/status')
      .set('Authorization', 'Bearer ' + ok.body.token);
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.body.enabled).toBe(true);
  });

  test('códigos de respaldo permiten entrar una sola vez', async () => {
    const { email, password, token } = await registerTherapist();

    const setupRes = await request(app)
      .post('/api/v1/therapists/2fa/setup')
      .set('Authorization', 'Bearer ' + token);
    const confirmRes = await request(app)
      .post('/api/v1/therapists/2fa/confirm')
      .set('Authorization', 'Bearer ' + token)
      .send({ code: currentCode(setupRes.body.secret) });
    const backupCode = confirmRes.body.backup_codes[0];

    const loginRes = await login(email, password);
    expect(loginRes.body.requires_2fa).toBe(true);

    const firstUse = await request(app)
      .post('/api/v1/therapists/verify-2fa')
      .send({ two_factor_token: loginRes.body.two_factor_token, code: backupCode.toLowerCase() });
    expect(firstUse.statusCode).toBe(200);
    expect(firstUse.body.success).toBe(true);

    // Reutilizar el mismo código → 401 (single-use)
    const secondLogin = await login(email, password);
    const secondUse = await request(app)
      .post('/api/v1/therapists/verify-2fa')
      .send({ two_factor_token: secondLogin.body.two_factor_token, code: backupCode });
    expect(secondUse.statusCode).toBe(401);
  });

  test('disable exige código TOTP y vuelve al login normal', async () => {
    const { email, password, token } = await registerTherapist();

    const setupRes = await request(app)
      .post('/api/v1/therapists/2fa/setup')
      .set('Authorization', 'Bearer ' + token);
    const secret = setupRes.body.secret;
    await request(app)
      .post('/api/v1/therapists/2fa/confirm')
      .set('Authorization', 'Bearer ' + token)
      .send({ code: currentCode(secret) });

    // Código incorrecto → no desactiva
    const badDisable = await request(app)
      .post('/api/v1/therapists/2fa/disable')
      .set('Authorization', 'Bearer ' + token)
      .send({ code: '000000' });
    expect(badDisable.statusCode).toBe(401);

    // Código correcto → desactiva
    const disable = await request(app)
      .post('/api/v1/therapists/2fa/disable')
      .set('Authorization', 'Bearer ' + token)
      .send({ code: currentCode(secret) });
    expect(disable.statusCode).toBe(200);
    expect(disable.body.success).toBe(true);

    // Login vuelve a ser de un solo paso
    const res = await login(email, password);
    expect(res.body.success).toBe(true);
    expect(res.body.requires_2fa).toBeUndefined();
    expect(res.body.token).toBeTruthy();
  });

  test('el secreto se guarda cifrado en la BD', async () => {
    const { token, therapist } = await registerTherapist();
    const setupRes = await request(app)
      .post('/api/v1/therapists/2fa/setup')
      .set('Authorization', 'Bearer ' + token);
    const { rows } = await pool.query(
      'SELECT two_factor_secret FROM therapists WHERE id = $1',
      [therapist.id]
    );
    expect(rows).toHaveLength(1);
    const stored = rows[0].two_factor_secret;
    expect(stored).toBeTruthy();
    expect(stored).not.toBe(setupRes.body.secret); // cifrado, no plaintext
    expect(stored.split(':')).toHaveLength(3); // iv:authTag:ciphertext
  });
});
