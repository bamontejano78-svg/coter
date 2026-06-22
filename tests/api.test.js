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
  // 🔒 Guardia: solo ejecutar en entorno de test
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('TESTS SOLO DEBEN EJECUTARSE CON NODE_ENV=test. Actual: ' + process.env.NODE_ENV);
  }
  
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

// ═══════════════════════════════════════════════════════════════
// PATIENT API — Integration Tests
// ═══════════════════════════════════════════════════════════════
describe('Patient API', () => {
  let patientId;
  let authToken;
  let therapistToken;
  let therapistId;
  let connectionCode;

  beforeAll(async () => {
    // 1. Registrar terapeuta
    const regRes = await request(app)
      .post('/api/v1/therapists/register')
      .send({ name: 'Dra. Integración', email: 'integracion@coter.com', specialty: 'psicologia_clinica', password: 'test1234' });
    therapistToken = regRes.body.token;
    therapistId = regRes.body.therapist.id;

    // 2. Crear código de conexión
    const codeRes = await request(app)
      .post('/api/v1/therapists/connection-codes')
      .set('Authorization', 'Bearer ' + therapistToken)
      .send({ duration_hours: 24, max_uses: 1 });
    connectionCode = codeRes.body.code;

    // 3. Conectar como paciente
    const connectRes = await request(app)
      .post('/api/v1/patients/connect')
      .send({ connection_code: connectionCode });
    patientId = connectRes.body.patient_id;
    authToken = connectRes.body.auth_token;
  }, 15000);

  // ─── CONEXIÓN ──────────────────────────────────────────
  describe('Connection', () => {
    test('POST /api/v1/patients/connect returns patient_id and auth_token', () => {
      expect(patientId).toBeDefined();
      expect(authToken).toBeDefined();
      expect(connectionCode).toBeDefined();
    });

    test('POST /connection-codes returns ISO expires_at in the future', async () => {
      const res = await request(app)
        .post('/api/v1/therapists/connection-codes')
        .set('Authorization', 'Bearer ' + therapistToken)
        .send({ duration_hours: 24, max_uses: 1 });
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.expires_at).toBe('string');
      expect(new Date(res.body.expires_at).getTime()).toBeGreaterThan(Date.now());
    });

    // Regression: cubre el path con patient_name que estaba roto en producción
    test('POST /api/v1/therapists/connection-codes accepts patient_name', async () => {
      const res = await request(app)
        .post('/api/v1/therapists/connection-codes')
        .set('Authorization', 'Bearer ' + therapistToken)
        .send({ duration_hours: 24, max_uses: 1, patient_name: 'Paciente Test' });
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.code).toMatch(/^TH-/);
      expect(res.body.patient_name).toBe('Paciente Test');
      // Verificar que el código se guardó con patient_name en BD
      const { rows } = await pool.query(
        'SELECT patient_name FROM connection_codes WHERE code = $1',
        [res.body.code]
      );
      expect(rows.length).toBe(1);
      expect(rows[0].patient_name).toBe('Paciente Test');
    });

    test('POST /api/v1/patients/connect rejects empty code', async () => {
      const res = await request(app)
        .post('/api/v1/patients/connect')
        .send({});
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toContain('Codigo');
    });

    test('POST /api/v1/patients/connect rejects invalid code', async () => {
      const res = await request(app)
        .post('/api/v1/patients/connect')
        .send({ connection_code: 'INVALID-CODE-999' });
      expect(res.statusCode).toBe(400);
    });
  });

  // ─── CHECK-INS ─────────────────────────────────────────
  describe('Check-ins', () => {
    let checkInId;

    test('POST /:patientId/check-ins creates a check-in', async () => {
      const res = await request(app)
        .post('/api/v1/patients/' + patientId + '/check-ins')
        .set('Authorization', 'Bearer ' + authToken)
        .send({ mood: 7, anxiety: 3, energy: 6, thoughts: 'Me siento bien hoy' });
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.check_in_id).toBeDefined();
      checkInId = res.body.check_in_id;
    });

    test('POST /:patientId/check-ins rejects missing mood', async () => {
      const res = await request(app)
        .post('/api/v1/patients/' + patientId + '/check-ins')
        .set('Authorization', 'Bearer ' + authToken)
        .send({ anxiety: 5, energy: 5 });
      expect(res.statusCode).toBe(400);
    });

    test('POST /:patientId/check-ins rejects missing anxiety', async () => {
      const res = await request(app)
        .post('/api/v1/patients/' + patientId + '/check-ins')
        .set('Authorization', 'Bearer ' + authToken)
        .send({ mood: 7, energy: 5 });
      expect(res.statusCode).toBe(400);
    });

    test('POST /:patientId/check-ins defaults energy to 5 when omitted', async () => {
      const res = await request(app)
        .post('/api/v1/patients/' + patientId + '/check-ins')
        .set('Authorization', 'Bearer ' + authToken)
        .send({ mood: 8, anxiety: 2 });
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
    });

    test('POST /:patientId/check-ins with low mood', async () => {
      const res = await request(app)
        .post('/api/v1/patients/' + patientId + '/check-ins')
        .set('Authorization', 'Bearer ' + authToken)
        .send({ mood: 2, anxiety: 9, energy: 3, thoughts: 'Día difícil' });
      expect(res.statusCode).toBe(200);
    });

    test('GET /:patientId/check-ins returns list', async () => {
      const res = await request(app)
        .get('/api/v1/patients/' + patientId + '/check-ins')
        .set('Authorization', 'Bearer ' + authToken);
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.check_ins)).toBe(true);
      expect(res.body.check_ins.length).toBeGreaterThanOrEqual(3);
      // Los pensamientos deben estar desencriptados
      const firstCheckin = res.body.check_ins[0];
      expect(firstCheckin).toHaveProperty('mood');
      expect(firstCheckin).toHaveProperty('anxiety');
      expect(firstCheckin).toHaveProperty('energy');
      expect(firstCheckin).toHaveProperty('thoughts');
    });
  });

  // ─── MENSAJES ──────────────────────────────────────────
  describe('Messages', () => {
    test('POST /:patientId/messages sends a message from patient', async () => {
      const res = await request(app)
        .post('/api/v1/patients/' + patientId + '/messages')
        .set('Authorization', 'Bearer ' + authToken)
        .send({ message: 'Hola doctora, tengo una duda sobre la tarea' });
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message_id).toBeDefined();
    });

    test('POST /:patientId/messages rejects empty message', async () => {
      const res = await request(app)
        .post('/api/v1/patients/' + patientId + '/messages')
        .set('Authorization', 'Bearer ' + authToken)
        .send({ message: '' });
      expect(res.statusCode).toBe(400);
    });

    test('POST /:patientId/messages rejects missing message', async () => {
      const res = await request(app)
        .post('/api/v1/patients/' + patientId + '/messages')
        .set('Authorization', 'Bearer ' + authToken)
        .send({});
      expect(res.statusCode).toBe(400);
    });

    test('GET /:patientId/messages returns decrypted messages', async () => {
      const res = await request(app)
        .get('/api/v1/patients/' + patientId + '/messages')
        .set('Authorization', 'Bearer ' + authToken);
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.messages)).toBe(true);
      expect(res.body.messages.length).toBeGreaterThanOrEqual(1);
      const msg = res.body.messages[0];
      expect(msg).toHaveProperty('message');
      expect(msg).toHaveProperty('is_therapist');
      expect(typeof msg.message).toBe('string');
      expect(msg.message.length).toBeGreaterThan(0);
    });
  });

  // ─── TAREAS (ASSIGNMENTS) ──────────────────────────────
  describe('Assignments (Tasks)', () => {
    let assignmentId;

    beforeAll(async () => {
      // El terapeuta crea una tarea para el paciente
      const res = await request(app)
        .post('/api/v1/therapists/patients/' + patientId + '/assignments')
        .set('Authorization', 'Bearer ' + therapistToken)
        .send({
          type: 'cognitive_restructuring',
          title: 'Registro de pensamientos automáticos',
          instructions: 'Anota 3 pensamientos negativos y busca evidencia a favor y en contra',
        });
      assignmentId = res.body.assignment_id;
    });

    test('GET /:patientId/assignments returns patient tasks', async () => {
      const res = await request(app)
        .get('/api/v1/patients/' + patientId + '/assignments')
        .set('Authorization', 'Bearer ' + authToken);
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.assignments)).toBe(true);
      expect(res.body.assignments.length).toBeGreaterThanOrEqual(1);
      const task = res.body.assignments[0];
      expect(task).toHaveProperty('title');
      expect(task).toHaveProperty('instructions');
      expect(task).toHaveProperty('status');
      expect(task.status).toBe('assigned');
    });

    test('PUT /:patientId/assignments/:id completes a task', async () => {
      const res = await request(app)
        .put('/api/v1/patients/' + patientId + '/assignments/' + assignmentId)
        .set('Authorization', 'Bearer ' + authToken);
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('completada');
    });

    test('GET /:patientId/assignments shows completed tasks filtered out', async () => {
      const res = await request(app)
        .get('/api/v1/patients/' + patientId + '/assignments')
        .set('Authorization', 'Bearer ' + authToken);
      expect(res.statusCode).toBe(200);
      // Todas las tareas devueltas deben estar en estado 'assigned'
      const allAssigned = res.body.assignments.every(a => a.status === 'assigned');
      expect(allAssigned).toBe(true);
    });
  });

  // ─── PROGRESO ──────────────────────────────────────────
  describe('Progress', () => {
    test('GET /:patientId/progress returns achievements and trends', async () => {
      const res = await request(app)
        .get('/api/v1/patients/' + patientId + '/progress')
        .set('Authorization', 'Bearer ' + authToken);
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.progress).toBeDefined();

      const progress = res.body.progress;
      expect(progress).toHaveProperty('achievements');
      expect(progress).toHaveProperty('weeklyTrends');
      expect(progress).toHaveProperty('activeGoals');
      expect(progress).toHaveProperty('timeline');

      // Debe tener datos de check-ins creados anteriormente
      expect(progress.achievements.totalCheckins).toBeGreaterThanOrEqual(3);
      expect(progress.achievements.completedTasks).toBeGreaterThanOrEqual(1);
      expect(progress.achievements.totalTasks).toBeGreaterThanOrEqual(1);
    });

    test('GET /:patientId/progress has timeline with checkins and completed tasks', async () => {
      const res = await request(app)
        .get('/api/v1/patients/' + patientId + '/progress')
        .set('Authorization', 'Bearer ' + authToken);
      const timeline = res.body.progress.timeline;
      expect(Array.isArray(timeline)).toBe(true);
      expect(timeline.length).toBeGreaterThan(0);

      const checkinItems = timeline.filter(t => t.type === 'checkin');
      const taskItems = timeline.filter(t => t.type === 'task_done');
      expect(checkinItems.length).toBeGreaterThan(0);
      expect(taskItems.length).toBeGreaterThan(0);
    });
  });

  // ─── GOALS ─────────────────────────────────────────────
  describe('Goals', () => {
    test('GET /:patientId/goals returns goals list', async () => {
      const res = await request(app)
        .get('/api/v1/patients/' + patientId + '/goals')
        .set('Authorization', 'Bearer ' + authToken);
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.goals)).toBe(true);
    });
  });

  // ─── NOTIFICACIONES ────────────────────────────────────
  describe('Notifications', () => {
    let notificationId;

    test('GET /:patientId/notifications returns notifications with unread_count', async () => {
      const res = await request(app)
        .get('/api/v1/patients/' + patientId + '/notifications')
        .set('Authorization', 'Bearer ' + authToken);
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.notifications)).toBe(true);
      expect(res.body).toHaveProperty('unread_count');
      // Guardar primera notificación para test individual
      if (res.body.notifications.length > 0) {
        notificationId = res.body.notifications[0].id;
      }
    });

    test('PUT /:patientId/notifications/:id/read marks single notification as read', async () => {
      if (!notificationId) return; // skip si no hay notificaciones
      const res = await request(app)
        .put('/api/v1/patients/' + patientId + '/notifications/' + notificationId + '/read')
        .set('Authorization', 'Bearer ' + authToken);
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
    });

    test('PUT /:patientId/notifications/read-all marks all as read', async () => {
      const res = await request(app)
        .put('/api/v1/patients/' + patientId + '/notifications/read-all')
        .set('Authorization', 'Bearer ' + authToken);
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);

      // Verificar que todas están leídas
      const getRes = await request(app)
        .get('/api/v1/patients/' + patientId + '/notifications')
        .set('Authorization', 'Bearer ' + authToken);
      expect(getRes.body.unread_count).toBe(0);
    });
  });

  // ─── PROTECCIÓN DE AUTENTICACIÓN ───────────────────────
  describe('Auth Protection', () => {
    test('GET check-ins without token returns 401', async () => {
      const res = await request(app)
        .get('/api/v1/patients/' + patientId + '/check-ins');
      expect(res.statusCode).toBe(401);
    });

    test('GET check-ins with invalid token returns 403', async () => {
      const res = await request(app)
        .get('/api/v1/patients/' + patientId + '/check-ins')
        .set('Authorization', 'Bearer invalid-token-12345');
      expect(res.statusCode).toBe(403);
    });

    test('GET check-ins with wrong patient token returns 403', async () => {
      const res = await request(app)
        .get('/api/v1/patients/' + patientId + '/check-ins')
        .set('Authorization', 'Bearer ' + therapistToken);
      expect(res.statusCode).toBe(403);
    });

    test('POST messages without token returns 401', async () => {
      const res = await request(app)
        .post('/api/v1/patients/' + patientId + '/messages')
        .send({ message: 'test' });
      expect(res.statusCode).toBe(401);
    });

    test('GET progress without token returns 401', async () => {
      const res = await request(app)
        .get('/api/v1/patients/' + patientId + '/progress');
      expect(res.statusCode).toBe(401);
    });

    test('Non-existent patient returns 403', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const res = await request(app)
        .get('/api/v1/patients/' + fakeId + '/check-ins')
        .set('Authorization', 'Bearer ' + authToken);
      expect(res.statusCode).toBe(403);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// THERAPIST DASHBOARD — Integration Tests
// ═══════════════════════════════════════════════════════════════
describe('Therapist Dashboard', () => {
  let therapistToken;
  let therapistId;
  let patientId;
  let patientAuthToken;

  beforeAll(async () => {
    // 1. Registrar terapeuta
    const regRes = await request(app)
      .post('/api/v1/therapists/register')
      .send({ name: 'Dr. Dashboard', email: 'dashboard@coter.com', specialty: 'psicologia', password: 'test1234' });
    therapistToken = regRes.body.token;
    therapistId = regRes.body.therapist.id;

    // 2. Crear código de conexión
    const codeRes = await request(app)
      .post('/api/v1/therapists/connection-codes')
      .set('Authorization', 'Bearer ' + therapistToken)
      .send({ duration_hours: 24, max_uses: 1 });

    // 3. Conectar paciente
    const connectRes = await request(app)
      .post('/api/v1/patients/connect')
      .send({ connection_code: codeRes.body.code });
    patientId = connectRes.body.patient_id;
    patientAuthToken = connectRes.body.auth_token;

    // 4. Crear check-ins variados (para datos del dashboard)
    // IMPORTANTE: el último check-in creado tiene mood=3 para que atRisk detecte riesgo
    await request(app)
      .post('/api/v1/patients/' + patientId + '/check-ins')
      .set('Authorization', 'Bearer ' + patientAuthToken)
      .send({ mood: 8, anxiety: 2, energy: 7, thoughts: 'Excelente día' });

    await request(app)
      .post('/api/v1/patients/' + patientId + '/check-ins')
      .set('Authorization', 'Bearer ' + patientAuthToken)
      .send({ mood: 6, anxiety: 5, energy: 5, thoughts: 'Día normal' });

    await request(app)
      .post('/api/v1/patients/' + patientId + '/check-ins')
      .set('Authorization', 'Bearer ' + patientAuthToken)
      .send({ mood: 3, anxiety: 8, energy: 2, thoughts: 'Día muy difícil' });

    // 5. Crear tarea pendiente
    await request(app)
      .post('/api/v1/therapists/patients/' + patientId + '/assignments')
      .set('Authorization', 'Bearer ' + therapistToken)
      .send({
        type: 'behavioral_activation',
        title: 'Agenda de actividades placenteras',
        instructions: 'Programa 3 actividades que disfrutes esta semana',
      });
  }, 20000);

  test('GET /api/v1/therapists/dashboard returns stats when empty', async () => {
    // Crear un terapeuta sin pacientes para probar dashboard vacío
    const emptyReg = await request(app)
      .post('/api/v1/therapists/register')
      .send({ name: 'Dr. Vacio', email: 'vacio@coter.com', specialty: 'psicologia', password: 'test1234' });
    const emptyToken = emptyReg.body.token;

    const res = await request(app)
      .get('/api/v1/therapists/dashboard')
      .set('Authorization', 'Bearer ' + emptyToken);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.dashboard.activePatients).toBe(0);
    expect(res.body.dashboard.todayCheckins).toBe(0);
    expect(res.body.dashboard.pendingTasks).toBe(0);
    expect(res.body.dashboard.atRisk).toBe(0);
  });

  test('GET /api/v1/therapists/dashboard returns populated stats', async () => {
    const res = await request(app)
      .get('/api/v1/therapists/dashboard')
      .set('Authorization', 'Bearer ' + therapistToken);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);

    const dash = res.body.dashboard;
    expect(dash).toHaveProperty('activePatients');
    expect(dash).toHaveProperty('todayCheckins');
    expect(dash).toHaveProperty('pendingTasks');
    expect(dash).toHaveProperty('atRisk');
    expect(dash).toHaveProperty('weeklyTrend');
    expect(dash).toHaveProperty('recentActivity');

    // Con 1 paciente conectado
    expect(dash.activePatients).toBeGreaterThanOrEqual(1);
    // Con 3 check-ins
    expect(dash.weeklyTrend.length).toBeGreaterThanOrEqual(1);
    // Con 1 check-in de mood=3, debería haber al menos 1 en riesgo
    expect(dash.atRisk).toBeGreaterThanOrEqual(1);
    // Con 1 tarea pendiente
    expect(dash.pendingTasks).toBeGreaterThanOrEqual(1);
  });

  test('GET /api/v1/therapists/dashboard requires auth', async () => {
    const res = await request(app).get('/api/v1/therapists/dashboard');
    expect(res.statusCode).toBe(401);
  });

  test('GET /api/v1/therapists/dashboard weeklyTrend has correct structure', async () => {
    const res = await request(app)
      .get('/api/v1/therapists/dashboard')
      .set('Authorization', 'Bearer ' + therapistToken);
    const trend = res.body.dashboard.weeklyTrend;
    expect(Array.isArray(trend)).toBe(true);
    if (trend.length > 0) {
      const day = trend[0];
      expect(day).toHaveProperty('day');
      expect(day).toHaveProperty('avg_mood');
      expect(day).toHaveProperty('avg_anxiety');
      expect(day).toHaveProperty('avg_energy');
      expect(day).toHaveProperty('checkins');
    }
  });

  test('GET /api/v1/therapists/dashboard recentActivity shows latest check-ins', async () => {
    const res = await request(app)
      .get('/api/v1/therapists/dashboard')
      .set('Authorization', 'Bearer ' + therapistToken);
    const recent = res.body.dashboard.recentActivity;
    expect(Array.isArray(recent)).toBe(true);
    if (recent.length > 0) {
      const activity = recent[0];
      expect(activity).toHaveProperty('type');
      expect(activity).toHaveProperty('mood');
      expect(activity).toHaveProperty('created_at');
    }
  });

  test('GET /api/v1/therapists/patients lists connected patients', async () => {
    const res = await request(app)
      .get('/api/v1/therapists/patients')
      .set('Authorization', 'Bearer ' + therapistToken);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.patients)).toBe(true);
    expect(res.body.patients.length).toBeGreaterThanOrEqual(1);
    // Verificar estructura
    const patient = res.body.patients[0];
    expect(patient).toHaveProperty('id');
    expect(patient).toHaveProperty('status');
    expect(patient).toHaveProperty('connection_code');
  });

  test('GET /api/v1/therapists/patients/:id returns full profile', async () => {
    const res = await request(app)
      .get('/api/v1/therapists/patients/' + patientId)
      .set('Authorization', 'Bearer ' + therapistToken);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.patient).toBeDefined();
    expect(res.body.patient).toHaveProperty('checkIns');
    expect(res.body.patient).toHaveProperty('messages');
    expect(res.body.patient).toHaveProperty('assignments');
    expect(res.body.patient).toHaveProperty('goals');
    expect(res.body.patient).toHaveProperty('metrics');
    expect(res.body.patient.metrics).toHaveProperty('avg_mood');
    expect(res.body.patient.metrics).toHaveProperty('avg_anxiety');
    expect(res.body.patient.metrics).toHaveProperty('total_checkins');
  });

  test('GET /api/v1/therapists/patients/:id returns 404 for unknown patient', async () => {
    const res = await request(app)
      .get('/api/v1/therapists/patients/00000000-0000-0000-0000-000000000000')
      .set('Authorization', 'Bearer ' + therapistToken);
    expect(res.statusCode).toBe(404);
  });

  test('GET /api/v1/therapists/patients requires auth', async () => {
    const res = await request(app).get('/api/v1/therapists/patients');
    expect(res.statusCode).toBe(401);
  });

  test('POST /api/v1/therapists/patients/:id/messages sends therapist message', async () => {
    const res = await request(app)
      .post('/api/v1/therapists/patients/' + patientId + '/messages')
      .set('Authorization', 'Bearer ' + therapistToken)
      .send({ message: '¿Cómo te fue con la tarea de registro de pensamientos?' });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message_id).toBeDefined();
  });

  test('POST /api/v1/therapists/patients/:id/messages rejects empty message', async () => {
    const res = await request(app)
      .post('/api/v1/therapists/patients/' + patientId + '/messages')
      .set('Authorization', 'Bearer ' + therapistToken)
      .send({ message: '   ' });
    expect(res.statusCode).toBe(400);
  });

  test('POST /api/v1/therapists/patients/:id/assignments creates task', async () => {
    const res = await request(app)
      .post('/api/v1/therapists/patients/' + patientId + '/assignments')
      .set('Authorization', 'Bearer ' + therapistToken)
      .send({
        type: 'journaling',
        title: 'Diario de gratitud',
        instructions: 'Escribe 3 cosas por las que estás agradecido hoy',
        due_date: new Date(Date.now() + 86400000 * 3).toISOString(),
      });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.assignment_id).toBeDefined();
  });

  test('POST /api/v1/therapists/patients/:id/assignments rejects missing fields', async () => {
    const res = await request(app)
      .post('/api/v1/therapists/patients/' + patientId + '/assignments')
      .set('Authorization', 'Bearer ' + therapistToken)
      .send({ type: 'journaling' });
    expect(res.statusCode).toBe(400);
  });
});
