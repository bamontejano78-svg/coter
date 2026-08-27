// Tests de integración — Auditoría de acceso a fichas clínicas
// Ejecutar: npm run test:integration (requiere PostgreSQL de test)

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { getPool, initializeDatabase, closeDatabase } = require('../database');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/coter_test';
process.env.JWT_SECRET = 'test_secret_key_for_testing_1234567890';
process.env.ENCRYPTION_KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-admin-password-123456';

let app;
let pool;

async function setupTherapistAndPatient() {
  const email = 'audit-' + uuidv4() + '@coter.com';
  const reg = await request(app)
    .post('/api/v1/therapists/register')
    .send({ name: 'Terapeuta Auditoría', email, specialty: 'psicologia', password: '123456' });
  expect(reg.statusCode).toBe(200);
  const therapistToken = reg.body.token;

  const codeRes = await request(app)
    .post('/api/v1/therapists/connection-codes')
    .set('Authorization', 'Bearer ' + therapistToken)
    .send({ duration_hours: 24, max_uses: 1 });
  expect(codeRes.statusCode).toBe(200);

  const connectRes = await request(app)
    .post('/api/v1/patients/connect')
    .send({ connection_code: codeRes.body.code });
  expect(connectRes.statusCode).toBe(200);

  return {
    patientId: connectRes.body.patient_id,
    authToken: connectRes.body.auth_token,
    therapistToken,
  };
}

function cookieHeader(res) {
  const setCookie = res.headers['set-cookie'];
  const arr = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  return arr.map(c => c.split(';')[0]).join('; ');
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('TESTS SOLO DEBEN EJECUTARSE CON NODE_ENV=test. Actual: ' + process.env.NODE_ENV);
  }

  await initializeDatabase();
  pool = getPool();

  // Limpiar tablas que afectan a estos tests
  await pool.query('DELETE FROM patient_access_audit');
  await pool.query('DELETE FROM admin_settings');
  await pool.query('DELETE FROM admin_2fa_backup_codes');
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

describe('Auditoría de acceso a fichas clínicas', () => {
  test('consultar ficha, notas y exportar registra la traza', async () => {
    const { patientId, therapistToken } = await setupTherapistAndPatient();

    const profile = await request(app)
      .get('/api/v1/therapists/patients/' + patientId)
      .set('Authorization', 'Bearer ' + therapistToken);
    expect(profile.statusCode).toBe(200);

    const notes = await request(app)
      .get('/api/v1/therapists/patients/' + patientId + '/clinical-notes')
      .set('Authorization', 'Bearer ' + therapistToken);
    expect(notes.statusCode).toBe(200);

    const exportRes = await request(app)
      .get('/api/v1/therapists/export/' + patientId)
      .set('Authorization', 'Bearer ' + therapistToken);
    expect(exportRes.statusCode).toBe(200);

    const { rows } = await pool.query(
      'SELECT action, therapist_id FROM patient_access_audit WHERE patient_id = $1 ORDER BY created_at ASC',
      [patientId]
    );
    const actions = rows.map(r => r.action);
    expect(actions).toContain('view_patient');
    expect(actions).toContain('view_notes');
    expect(actions).toContain('export_patient_data');
    // Todas las filas pertenecen al terapeuta que accedió
    for (const r of rows) {
      expect(r.therapist_id).toBeTruthy();
    }
  });

  test('el acceso no autorizado no registra traza', async () => {
    const { patientId, therapistToken } = await setupTherapistAndPatient();
    // Segundo terapeuta sin vínculo con el paciente
    const reg = await request(app)
      .post('/api/v1/therapists/register')
      .send({ name: 'Otra Terapeuta', email: 'otra-' + uuidv4() + '@coter.com', specialty: 'psicologia', password: '123456' });

    const res = await request(app)
      .get('/api/v1/therapists/patients/' + patientId)
      .set('Authorization', 'Bearer ' + reg.body.token);
    expect(res.statusCode).toBe(404);

    const { rows } = await pool.query(
      'SELECT action FROM patient_access_audit WHERE patient_id = $1',
      [patientId]
    );
    expect(rows).toHaveLength(0);
    void therapistToken;
  });

  test('el admin consulta la traza con nombres de terapeuta y paciente', async () => {
    const { patientId, therapistToken } = await setupTherapistAndPatient();
    await request(app)
      .get('/api/v1/therapists/patients/' + patientId)
      .set('Authorization', 'Bearer ' + therapistToken);

    const login = await request(app).post('/api/v1/admin/session').send({ password: ADMIN_PASSWORD });
    expect(login.statusCode).toBe(200);
    const cookie = cookieHeader(login);

    const res = await request(app)
      .get('/api/v1/admin/patient-audit?limit=10')
      .set('Cookie', cookie);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);

    const entry = res.body.entries.find(e => e.patient_id === patientId);
    expect(entry).toBeDefined();
    expect(entry.therapist_name).toBe('Terapeuta Auditoría');
    expect(entry.patient_name).toBeTruthy();
    expect(entry.action).toBe('view_patient');
    expect(entry.created_at).toBeTruthy();
  });

  test('la traza sobrevive al borrado RGPD del paciente', async () => {
    const { patientId, authToken, therapistToken } = await setupTherapistAndPatient();
    await request(app)
      .get('/api/v1/therapists/patients/' + patientId)
      .set('Authorization', 'Bearer ' + therapistToken);

    const del = await request(app)
      .post('/api/v1/patients/' + patientId + '/delete')
      .set('Authorization', 'Bearer ' + authToken)
      .send({ confirm: 'BORRAR' });
    expect(del.statusCode).toBe(200);

    // La fila de auditoría sigue existiendo
    const { rows } = await pool.query(
      'SELECT action FROM patient_access_audit WHERE patient_id = $1',
      [patientId]
    );
    expect(rows.length).toBeGreaterThan(0);

    // En el panel admin aparece el paciente como eliminado
    const login = await request(app).post('/api/v1/admin/session').send({ password: ADMIN_PASSWORD });
    const cookie = cookieHeader(login);
    const res = await request(app)
      .get('/api/v1/admin/patient-audit?limit=50')
      .set('Cookie', cookie);
    const entry = res.body.entries.find(e => e.patient_id === patientId);
    expect(entry).toBeDefined();
    expect(entry.patient_name).toBeNull(); // paciente eliminado (RGPD)
  });
});
