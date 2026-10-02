// Tests de integración — Derechos RGPD del paciente (exportación y borrado)
// Ejecutar: npm run test:integration (requiere PostgreSQL de test)

require('../scripts/test-db-safety').prepareTestDatabase();
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const request = require('./helpers/request');
const { v4: uuidv4 } = require('uuid');
const { getPool, initializeDatabase, closeDatabase } = require('../database');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/coter_test';
process.env.JWT_SECRET = 'test_secret_key_for_testing_1234567890';
process.env.ENCRYPTION_KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

let app;
let pool;

// Crea un terapeuta, un código de conexión y un paciente conectado
async function setupTherapistAndPatient() {
  const email = 'gdpr-' + uuidv4() + '@coter.com';
  const reg = await request(app)
    .post('/api/v1/therapists/register')
    .send({ name: 'Terapeuta RGPD', email, specialty: 'psicologia', password: '123456' });
  expect(reg.statusCode).toBe(200);
  const therapistToken = reg.testSession.token;
  const therapistId = reg.testSession.id;

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
    therapistId,
  };
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('TESTS SOLO DEBEN EJECUTARSE CON NODE_ENV=test. Actual: ' + process.env.NODE_ENV);
  }

  await initializeDatabase();
  pool = getPool();

  // Limpiar tablas que afectan a estos tests
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

describe('RGPD del paciente — exportación', () => {
  test('export devuelve un JSON descargable con el perfil', async () => {
    const { patientId, authToken } = await setupTherapistAndPatient();

    const res = await request(app)
      .get('/api/v1/patients/' + patientId + '/export')
      .set('Authorization', 'Bearer ' + authToken);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toContain('attachment');

    const data = JSON.parse(res.text);
    expect(data.format).toBe('coter-patient-export');
    expect(data.version).toBe(1);
    expect(data.patient.id).toBe(patientId);
    expect(data.therapist).toHaveLength(1);
    expect(data.therapist[0].name).toBe('Terapeuta RGPD');
    expect(data.check_ins).toEqual([]);
    expect(data.messages).toEqual([]);
    expect(data.clinical_notes).toEqual([]);
  });

  test('export incluye check-ins y mensajes descifrados', async () => {
    const { patientId, authToken } = await setupTherapistAndPatient();

    await request(app)
      .post('/api/v1/patients/' + patientId + '/check-ins')
      .set('Authorization', 'Bearer ' + authToken)
      .send({ mood: 7, anxiety: 4, energy: 6, thoughts: 'Me siento mejor esta semana' });
    await request(app)
      .post('/api/v1/patients/' + patientId + '/messages')
      .set('Authorization', 'Bearer ' + authToken)
      .send({ message: 'Hola terapeuta' });

    const res = await request(app)
      .get('/api/v1/patients/' + patientId + '/export')
      .set('Authorization', 'Bearer ' + authToken);
    expect(res.statusCode).toBe(200);

    const data = JSON.parse(res.text);
    expect(data.check_ins).toHaveLength(1);
    expect(data.check_ins[0].thoughts).toBe('Me siento mejor esta semana');
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].message).toBe('Hola terapeuta');
  });

  test('export exige autenticación del paciente', async () => {
    const { patientId } = await setupTherapistAndPatient();
    const res = await request(app).get('/api/v1/patients/' + patientId + '/export');
    expect(res.statusCode).toBe(401);
  });
});

describe('RGPD del paciente — borrado', () => {
  test('borrado exige confirmación BORRAR', async () => {
    const { patientId, authToken } = await setupTherapistAndPatient();

    const noConfirm = await request(app)
      .post('/api/v1/patients/' + patientId + '/delete')
      .set('Authorization', 'Bearer ' + authToken)
      .send({});
    expect(noConfirm.statusCode).toBe(400);

    const wrongConfirm = await request(app)
      .post('/api/v1/patients/' + patientId + '/delete')
      .set('Authorization', 'Bearer ' + authToken)
      .send({ confirm: 'NO' });
    expect(wrongConfirm.statusCode).toBe(400);

    // El paciente sigue existiendo
    const { rows } = await pool.query('SELECT id FROM patients WHERE id = $1', [patientId]);
    expect(rows).toHaveLength(1);
  });

  test('borrado elimina al paciente y todos sus datos', async () => {
    const { patientId, authToken, therapistToken } = await setupTherapistAndPatient();

    await request(app)
      .post('/api/v1/patients/' + patientId + '/check-ins')
      .set('Authorization', 'Bearer ' + authToken)
      .send({ mood: 3, anxiety: 8, energy: 4, thoughts: 'Día difícil' });
    await request(app)
      .post('/api/v1/patients/' + patientId + '/messages')
      .set('Authorization', 'Bearer ' + authToken)
      .send({ message: 'Mensaje a borrar' });

    const del = await request(app)
      .post('/api/v1/patients/' + patientId + '/delete')
      .set('Authorization', 'Bearer ' + authToken)
      .send({ confirm: 'BORRAR' });
    expect(del.statusCode).toBe(200);
    expect(del.body.success).toBe(true);

    // Todo eliminado en cascada
    const patientRows = await pool.query('SELECT id FROM patients WHERE id = $1', [patientId]);
    expect(patientRows.rows).toHaveLength(0);
    const checkinRows = await pool.query('SELECT id FROM check_ins WHERE patient_id = $1', [patientId]);
    expect(checkinRows.rows).toHaveLength(0);
    const msgRows = await pool.query('SELECT id FROM messages WHERE patient_id = $1', [patientId]);
    expect(msgRows.rows).toHaveLength(0);
    const connRows = await pool.query('SELECT id FROM therapist_patients WHERE patient_id = $1', [patientId]);
    expect(connRows.rows).toHaveLength(0);

    // El token del paciente ya no vale
    const exportAfter = await request(app)
      .get('/api/v1/patients/' + patientId + '/export')
      .set('Authorization', 'Bearer ' + authToken);
    expect(exportAfter.statusCode).toBe(403);

    // El terapeuta ya no ve al paciente en su lista
    const patients = await request(app)
      .get('/api/v1/therapists/patients')
      .set('Authorization', 'Bearer ' + therapistToken);
    expect(patients.statusCode).toBe(200);
    const found = (patients.body.patients || []).find(p => p.id === patientId);
    expect(found).toBeUndefined();
  });
});
