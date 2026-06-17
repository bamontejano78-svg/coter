// Tests para Coter Pro
// Ejecutar: npm test

const request = require('supertest');
const { getPool, initializeDatabase, closeDatabase } = require('../database');

// Mockear config antes de cargar la app
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/coter_test';
process.env.JWT_SECRET = 'test_secret_key_for_testing_1234567890';
process.env.ENCRYPTION_KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

let app;
let pool;

beforeAll(async () => {
  // Conectar a BD de test
  await initializeDatabase();
  pool = getPool();
  // Limpiar tablas para tests
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

describe('API Health', () => {
  test('GET /api/health returns ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('GET /api/health includes environment', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body.environment).toBe('test');
  });
});

describe('Therapist Auth', () => {
  test('POST /api/v1/therapists/register creates therapist', async () => {
    const res = await request(app)
      .post('/api/v1/therapists/register')
      .send({ name: 'Dr. Test', email: 'test@coter.com', specialty: 'psicologia', password: '123456' });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeDefined();
    expect(res.body.therapist.name).toBe('Dr. Test');
  });

  test('POST /api/v1/therapists/register rejects duplicate email', async () => {
    const res = await request(app)
      .post('/api/v1/therapists/register')
      .send({ name: 'Dr. Test 2', email: 'test@coter.com', specialty: 'psicologia', password: '123456' });
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('registrado');
  });

  test('POST /api/v1/therapists/login with valid credentials', async () => {
    const res = await request(app)
      .post('/api/v1/therapists/login')
      .send({ email: 'test@coter.com', password: '123456' });
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeDefined();
  });

  test('POST /api/v1/therapists/login with invalid password', async () => {
    const res = await request(app)
      .post('/api/v1/therapists/login')
      .send({ email: 'test@coter.com', password: 'wrong' });
    expect(res.body.success).toBe(false);
  });

  test('POST /api/v1/therapists/register rejects short password', async () => {
    const res = await request(app)
      .post('/api/v1/therapists/register')
      .send({ name: 'Test', email: 'short@test.com', specialty: 'psi', password: '123' });
    expect(res.statusCode).toBe(400);
  });

  test('POST /api/v1/therapists/login rejects missing fields', async () => {
    const res = await request(app)
      .post('/api/v1/therapists/login')
      .send({ email: 'test@test.com' });
    expect(res.statusCode).toBe(400);
  });
});

describe('Protected Routes', () => {
  test('GET /api/v1/therapists/patients without token returns 401', async () => {
    const res = await request(app).get('/api/v1/therapists/patients');
    expect(res.statusCode).toBe(401);
  });
});

describe('404 Handling', () => {
  test('Unknown route returns 404', async () => {
    const res = await request(app).get('/api/nonexistent');
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toContain('Ruta no encontrada');
  });
});

describe('Rate Limiting', () => {
  test('Auth endpoints have rate limiting headers', async () => {
    const res = await request(app).post('/api/v1/therapists/login').send({});
    expect(res.headers).toHaveProperty('ratelimit-limit');
  });
});
