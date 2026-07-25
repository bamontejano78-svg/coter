/**
 * ═══════════════════════════════════════════════════════════════
 * Billing System — Unit & Integration Tests
 * ═══════════════════════════════════════════════════════════════
 *
 * Fase 1: sin Stripe. Prueba:
 *   - utils/billing.js (createTrialSubscription, countActivePatients,
 *     isTrialActive, checkAccess, logBillingEvent)
 *   - middleware/billing.js (billingGuard via authWithBilling)
 *   - routes/billing.js (GET /status, GET /usage)
 *   - Registro de terapeuta crea suscripción trial automáticamente
 */

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { getPool, initializeDatabase, closeDatabase } = require('../database');

// ─── Config de entorno de test ──────────────────────────────────
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/coter_test';
process.env.JWT_SECRET = 'test_secret_key_for_testing_1234567890';
process.env.ENCRYPTION_KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

let app;
let pool;

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('TESTS SOLO DEBEN EJECUTARSE CON NODE_ENV=test');
  }

  await initializeDatabase();
  pool = getPool();

  // Limpiar tablas de billing para tests
  await pool.query('DELETE FROM billing_events');
  await pool.query('DELETE FROM billing_usage');
  await pool.query('DELETE FROM subscriptions');

  // Limpiar otras tablas que afectan los tests
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

// ═══════════════════════════════════════════════════════════════
// UNIT TESTS — utils/billing.js
// ═══════════════════════════════════════════════════════════════
describe('Billing Utils — createTrialSubscription', () => {
  const { createTrialSubscription } = require('../utils/billing');
  let therapistId;

  beforeAll(async () => {
    const { rows } = await pool.query(
      "INSERT INTO therapists (id, name, email, password, specialty) VALUES ($1, 'Test', 'billing-unit@test.com', 'x', 'psi') RETURNING id",
      [uuidv4()]
    );
    therapistId = rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM billing_events WHERE therapist_id = $1', [therapistId]);
    await pool.query('DELETE FROM subscriptions WHERE therapist_id = $1', [therapistId]);
    await pool.query('DELETE FROM therapists WHERE id = $1', [therapistId]);
  });

  test('creates a trial subscription with default 14 days', async () => {
    const sub = await createTrialSubscription(pool, therapistId);

    expect(sub).toBeDefined();
    expect(sub.status).toBe('trialing');
    expect(sub.price_per_patient_cents).toBe(300);
    expect(new Date(sub.trial_ends_at).getTime()).toBeGreaterThan(Date.now());

    // Verificar que se guardó en BD
    const { rows } = await pool.query(
      'SELECT * FROM subscriptions WHERE therapist_id = $1',
      [therapistId]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('trialing');
  });

  test('is idempotent — calling again returns existing subscription (ON CONFLICT)', async () => {
    const sub1 = await createTrialSubscription(pool, therapistId);
    const sub2 = await createTrialSubscription(pool, therapistId);

    expect(sub1.id).toBe(sub2.id);
    expect(sub1.status).toBe('trialing');

    // Sigue habiendo solo 1 fila
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM subscriptions WHERE therapist_id = $1',
      [therapistId]
    );
    expect(rows[0].count).toBe(1);
  });

  test('creates a billing_event of type trial_started', async () => {
    const { rows } = await pool.query(
      "SELECT * FROM billing_events WHERE therapist_id = $1 AND event_type = 'trial_started'",
      [therapistId]
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].metadata).toHaveProperty('trialDays');
  });

  test('respects custom trialDays and pricePerPatientCents', async () => {
    const customTherapistId = uuidv4();
    await pool.query(
      'INSERT INTO therapists (id, name, email, password, specialty) VALUES ($1, $2, $3, $4, $5)',
      [customTherapistId, 'Custom', 'billing-custom@test.com', 'x', 'psi']
    );

    const sub = await createTrialSubscription(pool, customTherapistId, {
      trialDays: 7,
      pricePerPatientCents: 1000,
    });

    expect(sub.price_per_patient_cents).toBe(1000);
    const endsAt = new Date(sub.trial_ends_at).getTime();
    const now = Date.now();
    const diffDays = Math.round((endsAt - now) / 86400000);
    expect(diffDays).toBe(7);

    // Cleanup
    await pool.query('DELETE FROM billing_events WHERE therapist_id = $1', [customTherapistId]);
    await pool.query('DELETE FROM subscriptions WHERE therapist_id = $1', [customTherapistId]);
    await pool.query('DELETE FROM therapists WHERE id = $1', [customTherapistId]);
  });
});

describe('Billing Utils — countActivePatients', () => {
  const { countActivePatients } = require('../utils/billing');
  let therapistId;
  let patientId;

  beforeAll(async () => {
    const t = await pool.query(
      "INSERT INTO therapists (id, name, email, password, specialty) VALUES ($1, 'Count', 'count@test.com', 'x', 'psi') RETURNING id",
      [uuidv4()]
    );
    therapistId = t.rows[0].id;

    const p = await pool.query(
      "INSERT INTO patients (id, status, auth_token) VALUES ($1, 'active', $2) RETURNING id",
      [uuidv4(), uuidv4()]
    );
    patientId = p.rows[0].id;

    await pool.query(
      "INSERT INTO therapist_patients (id, therapist_id, patient_id, connection_code, status) VALUES ($1, $2, $3, 'TEST-001', 'active')",
      [uuidv4(), therapistId, patientId]
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM therapist_patients WHERE therapist_id = $1', [therapistId]);
    await pool.query('DELETE FROM patients WHERE id = $1', [patientId]);
    await pool.query('DELETE FROM therapists WHERE id = $1', [therapistId]);
  });

  test('counts active patients correctly', async () => {
    const count = await countActivePatients(pool, therapistId);
    expect(count).toBe(1);
  });

  test('returns 0 for therapist with no active patients', async () => {
    const count = await countActivePatients(pool, '00000000-0000-0000-0000-000000000000');
    expect(count).toBe(0);
  });

  test('excludes inactive patients from count', async () => {
    // Marcar el vínculo como inactive
    await pool.query(
      "UPDATE therapist_patients SET status = 'inactive' WHERE therapist_id = $1 AND patient_id = $2",
      [therapistId, patientId]
    );

    const count = await countActivePatients(pool, therapistId);
    expect(count).toBe(0);

    // Restaurar
    await pool.query(
      "UPDATE therapist_patients SET status = 'active' WHERE therapist_id = $1 AND patient_id = $2",
      [therapistId, patientId]
    );
  });
});

describe('Billing Utils — isTrialActive', () => {
  const { isTrialActive } = require('../utils/billing');
  let therapistId;

  beforeAll(async () => {
    const t = await pool.query(
      "INSERT INTO therapists (id, name, email, password, specialty) VALUES ($1, 'Trial', 'trial@test.com', 'x', 'psi') RETURNING id",
      [uuidv4()]
    );
    therapistId = t.rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM subscriptions WHERE therapist_id = $1', [therapistId]);
    await pool.query('DELETE FROM therapists WHERE id = $1', [therapistId]);
  });

  test('returns active false when no subscription exists', async () => {
    const result = await isTrialActive(pool, therapistId);
    expect(result.active).toBe(false);
    expect(result.endsAt).toBeNull();
    expect(result.daysLeft).toBe(0);
  });

  test('returns active true when trial is in the future', async () => {
    const futureEnd = new Date(Date.now() + 14 * 86400000);
    await pool.query(
      "INSERT INTO subscriptions (id, therapist_id, status, price_per_patient_cents, trial_ends_at) VALUES ($1, $2, 'trialing', 500, $3)",
      [uuidv4(), therapistId, futureEnd]
    );

    const result = await isTrialActive(pool, therapistId);
    expect(result.active).toBe(true);
    expect(result.daysLeft).toBeGreaterThanOrEqual(13); // ~14 days
  });

  test('returns active false when trial has expired', async () => {
    const pastEnd = new Date(Date.now() - 1 * 86400000); // ended yesterday
    await pool.query(
      'UPDATE subscriptions SET trial_ends_at = $1 WHERE therapist_id = $2',
      [pastEnd, therapistId]
    );

    const result = await isTrialActive(pool, therapistId);
    expect(result.active).toBe(false);
    expect(result.daysLeft).toBe(0);
  });

  test('returns active false when status is not trialing', async () => {
    await pool.query(
      "UPDATE subscriptions SET status = 'active' WHERE therapist_id = $1",
      [therapistId]
    );

    const result = await isTrialActive(pool, therapistId);
    expect(result.active).toBe(false);
  });
});

describe('Billing Utils — checkAccess', () => {
  const { checkAccess } = require('../utils/billing');
  let therapistId;

  beforeAll(async () => {
    const t = await pool.query(
      "INSERT INTO therapists (id, name, email, password, specialty) VALUES ($1, 'Access', 'access@test.com', 'x', 'psi') RETURNING id",
      [uuidv4()]
    );
    therapistId = t.rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM subscriptions WHERE therapist_id = $1', [therapistId]);
    await pool.query('DELETE FROM therapists WHERE id = $1', [therapistId]);
  });

  test('blocks access when no subscription exists', async () => {
    const result = await checkAccess(pool, therapistId);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('NO_SUBSCRIPTION');
  });

  test('allows access when status is trialing', async () => {
    const futureEnd = new Date(Date.now() + 14 * 86400000);
    await pool.query(
      "INSERT INTO subscriptions (id, therapist_id, status, price_per_patient_cents, trial_ends_at) VALUES ($1, $2, 'trialing', 500, $3)",
      [uuidv4(), therapistId, futureEnd]
    );

    const result = await checkAccess(pool, therapistId);
    expect(result.allowed).toBe(true);
    expect(result.subscription.status).toBe('trialing');
  });

  test('allows access when status is active', async () => {
    await pool.query(
      "UPDATE subscriptions SET status = 'active', current_period_start = NOW(), current_period_end = NOW() + INTERVAL '30 days' WHERE therapist_id = $1",
      [therapistId]
    );

    const result = await checkAccess(pool, therapistId);
    expect(result.allowed).toBe(true);
  });

  test('allows access when status is incomplete', async () => {
    await pool.query(
      "UPDATE subscriptions SET status = 'incomplete' WHERE therapist_id = $1",
      [therapistId]
    );

    const result = await checkAccess(pool, therapistId);
    expect(result.allowed).toBe(true);
  });

  test('blocks access when status is canceled', async () => {
    await pool.query(
      "UPDATE subscriptions SET status = 'canceled', canceled_at = NOW() WHERE therapist_id = $1",
      [therapistId]
    );

    const result = await checkAccess(pool, therapistId);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('SUBSCRIPTION_CANCELED');
  });

  test('allows access when past_due with < 7 days grace', async () => {
    // Set period_end to 3 days ago (grace still active: 3 < 7)
    const periodEnd = new Date(Date.now() - 3 * 86400000);
    await pool.query(
      "UPDATE subscriptions SET status = 'past_due', current_period_end = $1 WHERE therapist_id = $2",
      [periodEnd, therapistId]
    );

    const result = await checkAccess(pool, therapistId);
    expect(result.allowed).toBe(true);
  });

  test('blocks access when past_due with ≥ 7 days grace expired', async () => {
    // Set period_end to 10 days ago (grace expired)
    const periodEnd = new Date(Date.now() - 10 * 86400000);
    await pool.query(
      "UPDATE subscriptions SET status = 'past_due', current_period_end = $1 WHERE therapist_id = $2",
      [periodEnd, therapistId]
    );

    const result = await checkAccess(pool, therapistId);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('PAST_DUE_GRACE_EXPIRED');
  });
});

describe('Billing Utils — logBillingEvent', () => {
  const { logBillingEvent } = require('../utils/billing');
  let therapistId;

  beforeAll(async () => {
    const t = await pool.query(
      "INSERT INTO therapists (id, name, email, password, specialty) VALUES ($1, 'Log', 'log-billing@test.com', 'x', 'psi') RETURNING id",
      [uuidv4()]
    );
    therapistId = t.rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM billing_events WHERE therapist_id = $1', [therapistId]);
    await pool.query('DELETE FROM therapists WHERE id = $1', [therapistId]);
  });

  test('inserts a billing event with metadata', async () => {
    await logBillingEvent(pool, therapistId, 'patient_added', null, {
      count: 5,
      reason: 'test',
    });

    const { rows } = await pool.query(
      'SELECT * FROM billing_events WHERE therapist_id = $1 ORDER BY created_at DESC LIMIT 1',
      [therapistId]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].event_type).toBe('patient_added');
    expect(rows[0].metadata).toEqual({ count: 5, reason: 'test' });
  });

  test('does not throw on invalid event_type (DB rejects gracefully)', async () => {
    // Eventos con tipo inválido son rechazados por el CHECK constraint,
    // pero logBillingEvent captura el error y no propaga.
    let threw = false;
    try {
      await logBillingEvent(pool, therapistId, 'invalid_event_type_xyz', null, {});
    } catch (e) {
      threw = true;
    }
    // La función captura errores internamente (catch en el .query)
    // y no debería propagar
    expect(threw).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// INTEGRATION TESTS — Registro crea trial + rutas de billing
// ═══════════════════════════════════════════════════════════════
describe('Registration creates trial subscription', () => {
  test('POST /api/v1/therapists/register creates a trial subscription', async () => {
    const res = await request(app)
      .post('/api/v1/therapists/register')
      .send({
        name: 'Dr. Billing Test',
        email: 'billing-register@coter.com',
        specialty: 'psicologia',
        password: 'test1234',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);

    const therapistId = res.body.therapist.id;

    // Verificar que se creó la suscripción en trial
    const { rows } = await pool.query(
      'SELECT * FROM subscriptions WHERE therapist_id = $1',
      [therapistId]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('trialing');
    expect(rows[0].price_per_patient_cents).toBe(300);

    // Verificar que se registró el evento trial_started
    const { rows: events } = await pool.query(
      "SELECT * FROM billing_events WHERE therapist_id = $1 AND event_type = 'trial_started'",
      [therapistId]
    );
    expect(events.length).toBe(1);

    // Cleanup
    await pool.query('DELETE FROM billing_events WHERE therapist_id = $1', [therapistId]);
    await pool.query('DELETE FROM subscriptions WHERE therapist_id = $1', [therapistId]);
    await pool.query('DELETE FROM therapists WHERE id = $1', [therapistId]);
  });

  test('two registrations create two independent trial subscriptions', async () => {
    const r1 = await request(app)
      .post('/api/v1/therapists/register')
      .send({
        name: 'Dr. Alpha', email: 'alpha-billing@coter.com',
        specialty: 'psi', password: 'test1234',
      });

    const r2 = await request(app)
      .post('/api/v1/therapists/register')
      .send({
        name: 'Dr. Beta', email: 'beta-billing@coter.com',
        specialty: 'psi', password: 'test1234',
      });

    const { rows } = await pool.query(
      'SELECT therapist_id, status FROM subscriptions WHERE therapist_id = ANY($1::uuid[])',
      [[r1.body.therapist.id, r2.body.therapist.id]]
    );
    expect(rows.length).toBe(2);
    rows.forEach(r => expect(r.status).toBe('trialing'));

    // Cleanup
    await pool.query('DELETE FROM billing_events WHERE therapist_id = ANY($1::uuid[])', [[r1.body.therapist.id, r2.body.therapist.id]]);
    await pool.query('DELETE FROM subscriptions WHERE therapist_id = ANY($1::uuid[])', [[r1.body.therapist.id, r2.body.therapist.id]]);
    await pool.query('DELETE FROM therapists WHERE id = ANY($1::uuid[])', [[r1.body.therapist.id, r2.body.therapist.id]]);
  });
});

describe('Billing Routes — GET /status', () => {
  let therapistToken;
  let therapistId;

  beforeAll(async () => {
    const reg = await request(app)
      .post('/api/v1/therapists/register')
      .send({
        name: 'Dr. Status', email: 'status-billing@coter.com',
        specialty: 'psi', password: 'test1234',
      });
    therapistToken = reg.body.token;
    therapistId = reg.body.therapist.id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM billing_events WHERE therapist_id = $1', [therapistId]);
    await pool.query('DELETE FROM subscriptions WHERE therapist_id = $1', [therapistId]);
    await pool.query('DELETE FROM therapists WHERE id = $1', [therapistId]);
  });

  test('returns subscription status with trial info', async () => {
    const res = await request(app)
      .get('/api/v1/billing/status')
      .set('Authorization', 'Bearer ' + therapistToken);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.subscription.status).toBe('trialing');
    expect(res.body.subscription.pricePerPatientCents).toBe(300);
    expect(res.body.subscription.patientCount).toBe(0);
    expect(res.body.subscription.estimatedMonthlyCostCents).toBe(0);
    expect(res.body.subscription.trial).toBeDefined();
    expect(res.body.subscription.trial.active).toBe(true);
    expect(res.body.subscription.trial.daysLeft).toBeGreaterThanOrEqual(13);
  });

  test('returns 401 without auth token', async () => {
    const res = await request(app).get('/api/v1/billing/status');
    expect(res.statusCode).toBe(401);
  });

  test('returns correct patientCount when patients are connected', async () => {
    // Conectar un paciente
    const code = await request(app)
      .post('/api/v1/therapists/connection-codes')
      .set('Authorization', 'Bearer ' + therapistToken)
      .send({ duration_hours: 24, max_uses: 1 });

    await request(app)
      .post('/api/v1/patients/connect')
      .send({ connection_code: code.body.code });

    const res = await request(app)
      .get('/api/v1/billing/status')
      .set('Authorization', 'Bearer ' + therapistToken);

    expect(res.body.subscription.patientCount).toBe(1);
    expect(res.body.subscription.estimatedMonthlyCostCents).toBe(300); // 1 × 300
  });
});

describe('Billing Routes — GET /usage', () => {
  let therapistToken;
  let therapistId;

  beforeAll(async () => {
    const reg = await request(app)
      .post('/api/v1/therapists/register')
      .send({
        name: 'Dr. Usage', email: 'usage-billing@coter.com',
        specialty: 'psi', password: 'test1234',
      });
    therapistToken = reg.body.token;
    therapistId = reg.body.therapist.id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM billing_events WHERE therapist_id = $1', [therapistId]);
    await pool.query('DELETE FROM subscriptions WHERE therapist_id = $1', [therapistId]);
    await pool.query('DELETE FROM therapists WHERE id = $1', [therapistId]);
  });

  test('returns usage data with activePatients and estimated cost', async () => {
    const res = await request(app)
      .get('/api/v1/billing/usage')
      .set('Authorization', 'Bearer ' + therapistToken);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.usage.activePatients).toBe(0);
    expect(res.body.usage.pricePerPatientCents).toBe(300);
    expect(res.body.usage.estimatedMonthlyCostCents).toBe(0);
    expect(res.body.usage.period).toBeDefined();
    expect(res.body.usage.period.start).toBeDefined();
    expect(res.body.usage.period.end).toBeDefined();
  });

  test('returns 401 without auth token', async () => {
    const res = await request(app).get('/api/v1/billing/usage');
    expect(res.statusCode).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════
// INTEGRATION TESTS — billingGuard middleware
// ═══════════════════════════════════════════════════════════════
describe('Billing Guard — authWithBilling middleware', () => {
  let therapistToken;
  let therapistId;
  let canceledToken;
  let canceledId;

  beforeAll(async () => {
    // Terapeuta normal (trial activo)
    const reg = await request(app)
      .post('/api/v1/therapists/register')
      .send({
        name: 'Dr. Guard', email: 'guard-billing@coter.com',
        specialty: 'psi', password: 'test1234',
      });
    therapistToken = reg.body.token;
    therapistId = reg.body.therapist.id;

    // Terapeuta con suscripción cancelada
    const regCanceled = await request(app)
      .post('/api/v1/therapists/register')
      .send({
        name: 'Dr. Canceled', email: 'canceled-billing@coter.com',
        specialty: 'psi', password: 'test1234',
      });
    canceledToken = regCanceled.body.token;
    canceledId = regCanceled.body.therapist.id;

    // Cancelar manualmente
    await pool.query(
      "UPDATE subscriptions SET status = 'canceled', canceled_at = NOW() WHERE therapist_id = $1",
      [canceledId]
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM billing_events WHERE therapist_id = ANY($1::uuid[])', [[therapistId, canceledId]]);
    await pool.query('DELETE FROM subscriptions WHERE therapist_id = ANY($1::uuid[])', [[therapistId, canceledId]]);
    await pool.query('DELETE FROM therapists WHERE id = ANY($1::uuid[])', [[therapistId, canceledId]]);
  });

  test('therapist with active trial can access protected routes', async () => {
    const res = await request(app)
      .get('/api/v1/therapists/dashboard')
      .set('Authorization', 'Bearer ' + therapistToken);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('therapist with canceled subscription gets 402 on protected routes', async () => {
    const res = await request(app)
      .get('/api/v1/therapists/dashboard')
      .set('Authorization', 'Bearer ' + canceledToken);

    expect(res.statusCode).toBe(402);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('SUBSCRIPTION_CANCELED');
  });

  test('canceled therapist can still access billing routes (GET /billing/status)', async () => {
    // Las rutas de billing NO usan authWithBilling, solo authenticateToken.
    // Un terapeuta cancelado debería poder ver su estado de facturación.
    const res = await request(app)
      .get('/api/v1/billing/status')
      .set('Authorization', 'Bearer ' + canceledToken);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.subscription.status).toBe('canceled');
  });

  test('unauthenticated request gets 401 (not 402)', async () => {
    const res = await request(app)
      .get('/api/v1/therapists/dashboard');

    expect(res.statusCode).toBe(401);
  });

  test('therapist with canceled subscription cannot create connection codes', async () => {
    const res = await request(app)
      .post('/api/v1/therapists/connection-codes')
      .set('Authorization', 'Bearer ' + canceledToken)
      .send({ duration_hours: 24, max_uses: 1 });

    expect(res.statusCode).toBe(402);
  });

  test('therapist with canceled subscription cannot list patients', async () => {
    const res = await request(app)
      .get('/api/v1/therapists/patients')
      .set('Authorization', 'Bearer ' + canceledToken);

    expect(res.statusCode).toBe(402);
  });
});

// ═══════════════════════════════════════════════════════════════
// INTEGRATION — billingGuard no bloquea login/register
// ═══════════════════════════════════════════════════════════════
describe('Billing Guard — does not block public routes', () => {
  test('POST /login works even without subscription', async () => {
    // Registrar un terapeuta primero
    const reg = await request(app)
      .post('/api/v1/therapists/register')
      .send({
        name: 'Dr. Login', email: 'login-billing@coter.com',
        specialty: 'psi', password: 'test1234',
      });
    const id = reg.body.therapist.id;

    // Cancelar su suscripción
    await pool.query(
      "UPDATE subscriptions SET status = 'canceled' WHERE therapist_id = $1",
      [id]
    );

    // Aún puede hacer login
    const res = await request(app)
      .post('/api/v1/therapists/login')
      .send({ email: 'login-billing@coter.com', password: 'test1234' });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);

    // Cleanup
    await pool.query('DELETE FROM billing_events WHERE therapist_id = $1', [id]);
    await pool.query('DELETE FROM subscriptions WHERE therapist_id = $1', [id]);
    await pool.query('DELETE FROM therapists WHERE id = $1', [id]);
  });

  test('POST /password-recovery works without subscription', async () => {
    const res = await request(app)
      .post('/api/v1/therapists/password-recovery')
      .send({ email: 'nonexistent@coter.com' });

    // Debe devolver 200 (no 402), con mensaje genérico de seguridad
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// INTEGRATION — Migration 008 aplicada correctamente
// ═══════════════════════════════════════════════════════════════
describe('Migration 008 — Billing tables exist', () => {
  test('subscriptions table exists with correct columns', async () => {
    const { rows } = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'subscriptions'
      ORDER BY ordinal_position
    `);
    expect(rows.length).toBeGreaterThanOrEqual(8);

    const colNames = rows.map(r => r.column_name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('therapist_id');
    expect(colNames).toContain('stripe_customer_id');
    expect(colNames).toContain('stripe_subscription_id');
    expect(colNames).toContain('status');
    expect(colNames).toContain('price_per_patient_cents');
    expect(colNames).toContain('trial_ends_at');
  });

  test('billing_usage table exists with correct columns', async () => {
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'billing_usage'
    `);
    const colNames = rows.map(r => r.column_name);
    expect(colNames).toContain('therapist_id');
    expect(colNames).toContain('period_start');
    expect(colNames).toContain('period_end');
    expect(colNames).toContain('patient_count');
    expect(colNames).toContain('amount_cents');
  });

  test('billing_events table exists with correct columns', async () => {
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'billing_events'
    `);
    const colNames = rows.map(r => r.column_name);
    expect(colNames).toContain('therapist_id');
    expect(colNames).toContain('event_type');
    expect(colNames).toContain('patient_id');
    expect(colNames).toContain('metadata');
  });

  test('billing_started_at column exists on therapist_patients', async () => {
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'therapist_patients' AND column_name = 'billing_started_at'
    `);
    expect(rows.length).toBe(1);
  });

  test('subscriptions CHECK constraint rejects invalid status', async () => {
    const id = uuidv4();
    let threw = false;
    try {
      await pool.query(
        "INSERT INTO subscriptions (id, therapist_id, status, price_per_patient_cents, trial_ends_at) VALUES ($1, '00000000-0000-0000-0000-000000000000', 'invalid_status', 500, NOW())",
        [id]
      );
    } catch (err) {
      if (err && err.code === '23514') threw = true;
    }
    expect(threw).toBe(true);
  });

  test('billing_events CHECK constraint rejects invalid event_type', async () => {
    const id = uuidv4();
    let threw = false;
    try {
      await pool.query(
        "INSERT INTO billing_events (id, therapist_id, event_type) VALUES ($1, '00000000-0000-0000-0000-000000000000', 'bad_event')",
        [id]
      );
    } catch (err) {
      if (err && err.code === '23514') threw = true;
    }
    expect(threw).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// INTEGRATION — Pioneer System (100 Pioneros)
// ═══════════════════════════════════════════════════════════════
describe('Pioneer System', () => {
  test('first therapist registered is a pioneer', async () => {
    const res = await request(app)
      .post('/api/v1/therapists/register')
      .send({
        name: 'Dr. Pioneer', email: 'pioneer1@coter.com',
        specialty: 'psi', password: 'test1234',
      });

    const therapistId = res.body.therapist.id;

    const { rows } = await pool.query(
      'SELECT is_pioneer, price_locked_until, price_per_patient_cents FROM subscriptions WHERE therapist_id = $1',
      [therapistId]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].is_pioneer).toBe(true);
    expect(rows[0].price_per_patient_cents).toBe(300);

    // price_locked_until debe estar ~12 meses en el futuro
    const lockedUntil = new Date(rows[0].price_locked_until).getTime();
    const expectedMin = Date.now() + 360 * 86400000; // ~11.8 meses
    expect(lockedUntil).toBeGreaterThan(expectedMin);

    // Cleanup
    await pool.query('DELETE FROM billing_events WHERE therapist_id = $1', [therapistId]);
    await pool.query('DELETE FROM subscriptions WHERE therapist_id = $1', [therapistId]);
    await pool.query('DELETE FROM therapists WHERE id = $1', [therapistId]);
  });

  test('GET /billing/status includes pioneer info', async () => {
    const reg = await request(app)
      .post('/api/v1/therapists/register')
      .send({
        name: 'Dr. Pioneer2', email: 'pioneer2@coter.com',
        specialty: 'psi', password: 'test1234',
      });

    const token = reg.body.token;
    const therapistId = reg.body.therapist.id;

    const res = await request(app)
      .get('/api/v1/billing/status')
      .set('Authorization', 'Bearer ' + token);

    expect(res.body.subscription.isPioneer).toBe(true);
    expect(res.body.subscription.priceLockedUntil).toBeDefined();
    expect(res.body.subscription.pricePerPatientCents).toBe(300);

    // Cleanup
    await pool.query('DELETE FROM billing_events WHERE therapist_id = $1', [therapistId]);
    await pool.query('DELETE FROM subscriptions WHERE therapist_id = $1', [therapistId]);
    await pool.query('DELETE FROM therapists WHERE id = $1', [therapistId]);
  });

  test('createTrialSubscription with custom price opts does not set pioneer', async () => {
    const { createTrialSubscription } = require('../utils/billing');
    const therapistId = uuidv4();
    await pool.query(
      'INSERT INTO therapists (id, name, email, password, specialty) VALUES ($1, $2, $3, $4, $5)',
      [therapistId, 'CustomPrice', 'customprice@test.com', 'x', 'psi']
    );

    const sub = await createTrialSubscription(pool, therapistId, {
      pricePerPatientCents: 1000,
    });

    expect(sub.is_pioneer).toBe(false);
    expect(sub.price_locked_until).toBeNull();
    expect(sub.price_per_patient_cents).toBe(1000);

    // Cleanup
    await pool.query('DELETE FROM billing_events WHERE therapist_id = $1', [therapistId]);
    await pool.query('DELETE FROM subscriptions WHERE therapist_id = $1', [therapistId]);
    await pool.query('DELETE FROM therapists WHERE id = $1', [therapistId]);
  });

  test('pioneer_activated event is logged for pioneers', async () => {
    const { createTrialSubscription } = require('../utils/billing');
    const therapistId = uuidv4();
    await pool.query(
      'INSERT INTO therapists (id, name, email, password, specialty) VALUES ($1, $2, $3, $4, $5)',
      [therapistId, 'PioneerEvent', 'pioneerevent@test.com', 'x', 'psi']
    );

    await createTrialSubscription(pool, therapistId);

    const { rows } = await pool.query(
      "SELECT * FROM billing_events WHERE therapist_id = $1 AND event_type = 'pioneer_activated'",
      [therapistId]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].metadata).toHaveProperty('priceLockedUntil');

    // Cleanup
    await pool.query('DELETE FROM billing_events WHERE therapist_id = $1', [therapistId]);
    await pool.query('DELETE FROM subscriptions WHERE therapist_id = $1', [therapistId]);
    await pool.query('DELETE FROM therapists WHERE id = $1', [therapistId]);
  });
});
