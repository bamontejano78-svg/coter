/**
 * ═══════════════════════════════════════════════════════════════
 * Billing — Coter Pro
 *
 * Módulo de facturación para suscripción por paciente activo.
 * Modelo: Stripe metered billing + 14 días de trial sin tarjeta.
 *
 * Fase 1 (esta implementación):
 *   - createTrialSubscription(): crea fila subscriptions en trial
 *   - countActivePatients(): cuenta pacientes activos de un terapeuta
 *   - isTrialActive(): verifica si el trial sigue vigente
 *   - checkAccess(): middleware helper — ¿puede este terapeuta usar la app?
 *   - logBillingEvent(): registra evento en billing_events
 *
 * Fase 2 (pendiente):
 *   - Integración con Stripe API (customers, subscriptions, usage records)
 *   - Webhook handler para eventos de Stripe
 *   - Cron job de reporte mensual de uso
 * ═══════════════════════════════════════════════════════════════
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../config/logger');

/**
 * Crea una suscripción en trial para un terapeuta recién registrado.
 * Se llama desde POST /therapists/register.
 *
 * @param {Object} pool - Pool de PostgreSQL
 * @param {string} therapistId - UUID del terapeuta
 * @param {Object} [opts]
 * @param {number} [opts.trialDays=14] - Días de trial
 * @param {number} [opts.pricePerPatientCents=300] - Precio en céntimos (default 3.00€, precio pionero)
 * @returns {Promise<Object>} La fila subscriptions creada
 */
async function createTrialSubscription(pool, therapistId, opts = {}) {
  const trialDays = opts.trialDays || 14;
  const priceCents = opts.pricePerPatientCents || 300;

  const trialEndsAt = new Date(Date.now() + trialDays * 86400000);

  // ── Sistema de Pioneros: primeros 100 terapeutas ──
  // Solo aplica cuando no se fuerza un precio custom (opts.pricePerPatientCents
  // no fue pasado explícitamente) y no es un ON CONFLICT (ya existente).
  let isPioneer = false;
  let priceLockedUntil = null;
  const hasCustomPrice = opts.pricePerPatientCents !== undefined;

  if (!hasCustomPrice) {
    const { rows: pioneerCount } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM subscriptions WHERE is_pioneer = TRUE'
    );
    if (pioneerCount[0].count < 100) {
      isPioneer = true;
      priceLockedUntil = new Date(Date.now() + 365 * 86400000); // 12 meses
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO subscriptions (id, therapist_id, status, price_per_patient_cents, trial_ends_at, is_pioneer, price_locked_until)
     VALUES ($1, $2, 'trialing', $3, $4, $5, $6)
     ON CONFLICT (therapist_id) DO NOTHING
     RETURNING *`,
    [uuidv4(), therapistId, priceCents, trialEndsAt, isPioneer, priceLockedUntil]
  );

  if (rows.length === 0) {
    // Ya existía (on conflict), devolvemos la existente
    const { rows: existing } = await pool.query(
      'SELECT * FROM subscriptions WHERE therapist_id = $1',
      [therapistId]
    );
    logger.info('Suscripción ya existente para terapeuta (createTrialSubscription)', { therapistId });
    return existing[0] || null;
  }

  await logBillingEvent(pool, therapistId, 'trial_started', null, {
    trialDays,
    trialEndsAt: trialEndsAt.toISOString(),
    pricePerPatientCents: priceCents,
    isPioneer,
  });

  if (isPioneer) {
    await logBillingEvent(pool, therapistId, 'pioneer_activated', null, {
      priceLockedUntil: priceLockedUntil.toISOString(),
      pricePerPatientCents: priceCents,
    });
    logger.info('Pionero activado', { therapistId, priceLockedUntil: priceLockedUntil.toISOString() });
  }

  logger.info('Suscripción trial creada', { therapistId, trialEndsAt: trialEndsAt.toISOString(), isPioneer });
  return rows[0];
}

/**
 * Cuenta pacientes activos de un terapeuta.
 * Solo cuenta vínculos con status = 'active'.
 *
 * @param {Object} pool
 * @param {string} therapistId
 * @returns {Promise<number>}
 */
async function countActivePatients(pool, therapistId) {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS count FROM therapist_patients WHERE therapist_id = $1 AND status = 'active'",
    [therapistId]
  );
  return rows[0].count;
}

/**
 * Verifica si el trial de un terapeuta sigue vigente.
 *
 * @param {Object} pool
 * @param {string} therapistId
 * @returns {Promise<{active: boolean, endsAt: string|null, daysLeft: number}>}
 */
async function isTrialActive(pool, therapistId) {
  const { rows } = await pool.query(
    'SELECT trial_ends_at, status FROM subscriptions WHERE therapist_id = $1',
    [therapistId]
  );
  if (rows.length === 0) return { active: false, endsAt: null, daysLeft: 0 };

  const sub = rows[0];
  if (sub.status !== 'trialing') return { active: false, endsAt: null, daysLeft: 0 };

  const now = Date.now();
  const endsAt = new Date(sub.trial_ends_at).getTime();
  const daysLeft = Math.max(0, Math.ceil((endsAt - now) / 86400000));

  return { active: daysLeft > 0, endsAt: sub.trial_ends_at, daysLeft };
}

/**
 * Verifica si un terapeuta tiene acceso a la plataforma.
 * Devuelve { allowed: true } o { allowed: false, reason, code }.
 *
 * Reglas:
 *   - Sin fila subscriptions → bloqueado (no debería pasar en prod)
 *   - status = 'trialing' → acceso permitido
 *   - status = 'active' → acceso permitido
 *   - status = 'past_due' + < 7 días → acceso permitido (gracia)
 *   - status = 'past_due' + ≥ 7 días → bloqueado
 *   - status = 'canceled' → bloqueado
 *   - status = 'incomplete' → acceso permitido
 *
 * @param {Object} pool
 * @param {string} therapistId
 * @returns {Promise<{allowed: boolean, reason?: string, code?: string, subscription?: Object}>}
 */
async function checkAccess(pool, therapistId) {
  const { rows } = await pool.query(
    'SELECT * FROM subscriptions WHERE therapist_id = $1',
    [therapistId]
  );

  if (rows.length === 0) {
    return { allowed: false, reason: 'No subscription found', code: 'NO_SUBSCRIPTION' };
  }

  const sub = rows[0];

  if (sub.status === 'trialing' || sub.status === 'active' || sub.status === 'incomplete') {
    return { allowed: true, subscription: sub };
  }

  if (sub.status === 'past_due') {
    // 7 días de gracia desde current_period_end
    const graceEnd = sub.current_period_end
      ? new Date(new Date(sub.current_period_end).getTime() + 7 * 86400000)
      : new Date(Date.now() - 1); // sin fecha, ya expiró
    if (Date.now() < graceEnd.getTime()) {
      return { allowed: true, subscription: sub };
    }
    return { allowed: false, reason: 'Suscripción con pago pendiente por más de 7 días', code: 'PAST_DUE_GRACE_EXPIRED', subscription: sub };
  }

  if (sub.status === 'canceled') {
    return { allowed: false, reason: 'Suscripción cancelada', code: 'SUBSCRIPTION_CANCELED', subscription: sub };
  }

  return { allowed: false, reason: 'Unknown subscription status', code: 'UNKNOWN', subscription: sub };
}

/**
 * Registra un evento de facturación en billing_events.
 *
 * @param {Object} pool
 * @param {string} therapistId
 * @param {string} eventType - Tipo de evento (ver CHECK constraint en migration)
 * @param {string|null} patientId
 * @param {Object} metadata
 * @returns {Promise<void>}
 */
async function logBillingEvent(pool, therapistId, eventType, patientId = null, metadata = {}) {
  const id = uuidv4();
  await pool.query(
    `INSERT INTO billing_events (id, therapist_id, event_type, patient_id, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, therapistId, eventType, patientId, JSON.stringify(metadata)]
  ).catch(err => {
    logger.error('Error registrando billing_event', { error: err.message, therapistId, eventType });
  });
}

/**
 * Transiciona el estado de una suscripción en la BD.
 * Usado por el handler de webhooks de Stripe.
 *
 * @param {Object} pool
 * @param {string} therapistId
 * @param {string} newStatus - 'active' | 'past_due' | 'canceled'
 * @param {Object} [opts]
 * @param {string} [opts.stripeSubscriptionId]
 * @param {Date|string} [opts.currentPeriodStart]
 * @param {Date|string} [opts.currentPeriodEnd]
 * @returns {Promise<Object|null>}
 */
async function transitionSubscription(pool, therapistId, newStatus, opts = {}) {
  const updates = ['status = $1', 'updated_at = NOW()'];
  const values = [newStatus];
  let idx = 2;

  if (opts.stripeSubscriptionId) {
    updates.push(`stripe_subscription_id = $${idx}`);
    values.push(opts.stripeSubscriptionId);
    idx++;
  }
  if (opts.currentPeriodStart) {
    updates.push(`current_period_start = $${idx}`);
    values.push(opts.currentPeriodStart);
    idx++;
  }
  if (opts.currentPeriodEnd) {
    updates.push(`current_period_end = $${idx}`);
    values.push(opts.currentPeriodEnd);
    idx++;
  }

  values.push(therapistId);

  const { rows } = await pool.query(
    `UPDATE subscriptions SET ${updates.join(', ')} WHERE therapist_id = $${idx} RETURNING *`,
    values
  );

  if (rows.length === 0) {
    logger.warn('No se encontró suscripción para transicionar', { therapistId, newStatus });
    return null;
  }

  await logBillingEvent(pool, therapistId, `subscription_${newStatus}`, null, {
    previousStatus: rows[0].status,
    newStatus,
    ...opts,
  });

  logger.info('Suscripción transicionada', { therapistId, newStatus });
  return rows[0];
}

/**
 * Encuentra el therapist_id a partir de un stripe_customer_id.
 *
 * @param {Object} pool
 * @param {string} stripeCustomerId
 * @returns {Promise<string|null>}
 */
async function findTherapistByStripeCustomer(pool, stripeCustomerId) {
  const { rows } = await pool.query(
    'SELECT therapist_id FROM subscriptions WHERE stripe_customer_id = $1',
    [stripeCustomerId]
  );
  return rows.length > 0 ? rows[0].therapist_id : null;
}

/**
 * Intenta reclamar un evento de Stripe para procesamiento idempotente.
 * Inserta una fila en stripe_webhook_events con el event.id de Stripe.
 * Si ya existe (PRIMARY KEY violation), devuelve false.
 *
 * Esto garantiza que el mismo webhook no se procese dos veces, incluso
 * si Stripe lo reintenta o si hay múltiples workers compitiendo.
 *
 * @param {Object} pool
 * @param {string} stripeEventId - El event.id de Stripe
 * @param {string} eventType - El event.type de Stripe (para logging)
 * @returns {Promise<boolean>} true si el evento es nuevo, false si ya fue procesado
 */
async function claimStripeEvent(pool, stripeEventId, eventType) {
  if (!stripeEventId) return true; // sin ID no podemos deduplicar, procesar igual

  try {
    await pool.query(
      'INSERT INTO stripe_webhook_events (stripe_event_id, event_type) VALUES ($1, $2)',
      [stripeEventId, eventType]
    );
    return true; // evento nuevo, podemos procesarlo
  } catch (err) {
    // 23505 = unique_violation: el evento ya fue procesado → skip seguro
    if (err.code === '23505') {
      logger.info('Webhook de Stripe ya procesado (idempotencia)', { stripeEventId, eventType });
      return false;
    }
    // 42P01 = undefined_table: la migración 009 no se ha aplicado aún.
    // No queremos rechazar webhooks legítimos por una migración pendiente.
    if (err.code === '42P01') {
      logger.warn('Tabla stripe_webhook_events no existe — migración 009 pendiente', { stripeEventId });
      return true;
    }
    // Otro error: fail-open para no perder webhooks legítimos
    logger.error('Error en claimStripeEvent', { error: err.message, code: err.code, stripeEventId, eventType });
    return true;
  }
}

module.exports = {
  createTrialSubscription,
  countActivePatients,
  isTrialActive,
  checkAccess,
  logBillingEvent,
  claimStripeEvent,
  transitionSubscription,
  findTherapistByStripeCustomer,
};
