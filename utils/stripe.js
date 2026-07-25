/**
 * ═══════════════════════════════════════════════════════════════
 * Stripe — Coter Pro
 *
 * Cliente de Stripe inicializado con la secret key del entorno.
 * La inicialización es lazy: si no hay STRIPE_SECRET_KEY, las
 * operaciones devuelven null/error controlado en lugar de crashear.
 *
 * En test (NODE_ENV=test), las operaciones de Stripe son no-ops
 * para que los tests de integración no dependan de Stripe.
 * ═══════════════════════════════════════════════════════════════
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../config/logger');
const config = require('../config/env');

/** @type {import('stripe').Stripe | null} */
let stripeClient = null;

function getStripe() {
  if (stripeClient) return stripeClient;
  if (!config.STRIPE_SECRET_KEY) {
    if (config.isProd) {
      logger.error('STRIPE_SECRET_KEY no configurado en producción');
    }
    return null;
  }
  try {
    const Stripe = require('stripe');
    stripeClient = new Stripe(config.STRIPE_SECRET_KEY, {
      apiVersion: '2025-03-31.basil',
    });
    logger.info('Cliente Stripe inicializado');
    return stripeClient;
  } catch (err) {
    logger.error('Error inicializando Stripe', { error: err.message });
    return null;
  }
}

/**
 * Crea un Customer de Stripe para un terapeuta.
 * Guarda el stripe_customer_id en la tabla subscriptions.
 *
 * @param {Object} pool - Pool de PostgreSQL
 * @param {string} therapistId
 * @param {string} email
 * @param {string} name
 * @returns {Promise<string|null>} stripe_customer_id o null si falla
 */
async function createStripeCustomer(pool, therapistId, email, name) {
  const stripe = getStripe();
  if (!stripe) {
    logger.warn('Stripe no disponible — no se creó customer', { therapistId });
    return null;
  }

  try {
    const customer = await stripe.customers.create({
      email,
      name,
      metadata: { therapist_id: therapistId },
    });

    // Guardar el stripe_customer_id en subscriptions
    await pool.query(
      'UPDATE subscriptions SET stripe_customer_id = $1, updated_at = NOW() WHERE therapist_id = $2',
      [customer.id, therapistId]
    );

    logger.info('Stripe customer creado', { therapistId, stripeCustomerId: customer.id });
    return customer.id;
  } catch (err) {
    logger.error('Error creando Stripe customer', { error: err.message, therapistId });
    return null;
  }
}

/**
 * Crea una Checkout Session de Stripe para que el terapeuta
 * introduzca sus datos de pago y active la suscripción.
 *
 * @param {Object} pool
 * @param {string} therapistId
 * @param {string} successUrl - URL a la que Stripe redirige tras pago exitoso
 * @param {string} cancelUrl - URL a la que Stripe redirige si cancela
 * @returns {Promise<{url: string, sessionId: string}|null>}
 */
async function createCheckoutSession(pool, therapistId, successUrl, cancelUrl) {
  const stripe = getStripe();
  if (!stripe) return null;

  // Obtener el stripe_customer_id y el price_id
  const { rows } = await pool.query(
    'SELECT stripe_customer_id, price_per_patient_cents FROM subscriptions WHERE therapist_id = $1',
    [therapistId]
  );

  if (rows.length === 0) {
    logger.warn('No hay suscripción para crear checkout', { therapistId });
    return null;
  }

  const sub = rows[0];
  let customerId = sub.stripe_customer_id;

  // Si no tiene customer_id aún (caso raro: registro antes de que
  // createStripeCustomer terminara), intentamos crearlo ahora.
  if (!customerId) {
    const { rows: tRows } = await pool.query(
      'SELECT email, name FROM therapists WHERE id = $1',
      [therapistId]
    );
    if (tRows.length === 0) return null;
    customerId = await createStripeCustomer(
      pool, therapistId, tRows[0].email, tRows[0].name
    );
    if (!customerId) return null;
  }

  const priceId = config.STRIPE_PRICE_ID;
  if (!priceId) {
    logger.error('STRIPE_PRICE_ID no configurado');
    return null;
  }

  try {
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      metadata: { therapist_id: therapistId },
      payment_method_types: ['card'],
      line_items: [{
        price: priceId,
        quantity: 1,
      }],
      mode: 'subscription',
      subscription_data: {
        metadata: { therapist_id: therapistId },
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
      locale: 'es',
    });

    logger.info('Stripe checkout session creada', {
      therapistId,
      sessionId: session.id,
    });

    return { url: session.url, sessionId: session.id };
  } catch (err) {
    logger.error('Error creando checkout session', { error: err.message, therapistId });
    return null;
  }
}

/**
 * Verifica la firma de un webhook de Stripe.
 *
 * @param {Buffer|string} rawBody - Body sin parsear
 * @param {string} signature - Header stripe-signature
 * @returns {{type: string, data: Object}|null} Evento verificado o null
 */
/**
 * Reporta el conteo de pacientes activos a Stripe para facturación
 * metered. Se ejecuta como cron job mensual (día 1 de cada mes).
 *
 * Para cada terapeuta con suscripción 'active' y stripe_subscription_id:
 *   1. Recupera la subscription de Stripe
 *   2. Encuentra el subscription_item con usage_type = 'metered'
 *   3. Reporta el conteo de pacientes con action = 'set'
 *   4. Guarda el snapshot en billing_usage
 *
 * @param {Object} pool - Pool de PostgreSQL
 * @returns {Promise<{reported: number, skipped: number, errors: number}>}
 */
async function reportMonthlyUsage(pool) {
  const stripe = getStripe();
  if (!stripe) {
    logger.warn('Stripe no disponible — no se reportó uso mensual');
    return { reported: 0, skipped: 0, errors: 0 };
  }

  let reported = 0;
  let skipped = 0;
  let errors = 0;

  // Obtener todas las suscripciones activas con Stripe subscription ID
  const { rows: subscribers } = await pool.query(
    `SELECT s.therapist_id, s.stripe_subscription_id, s.price_per_patient_cents
     FROM subscriptions s
     WHERE s.status = 'active'
       AND s.stripe_subscription_id IS NOT NULL`
  );

  if (subscribers.length === 0) {
    logger.info('No hay suscripciones activas para reportar uso mensual');
    return { reported: 0, skipped: 0, errors: 0 };
  }

  logger.info('Iniciando reporte mensual de uso a Stripe', { totalSubscribers: subscribers.length });

  for (const sub of subscribers) {
    try {
      // Contar pacientes activos
      const { rows: countRows } = await pool.query(
        "SELECT COUNT(*)::int AS count FROM therapist_patients WHERE therapist_id = $1 AND status = 'active'",
        [sub.therapist_id]
      );
      const patientCount = countRows[0].count;

      if (patientCount === 0) {
        skipped++;
        continue; // sin pacientes = sin cargo
      }

      // Recuperar la subscription de Stripe para obtener el subscription_item
      const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
      const meteredItem = stripeSub.items.data.find(
        (item) => item.plan.usage_type === 'metered'
      );

      if (!meteredItem) {
        logger.warn('No se encontró item metered en la subscription', {
          therapistId: sub.therapist_id,
          stripeSubscriptionId: sub.stripe_subscription_id,
        });
        skipped++;
        continue;
      }

      // Reportar uso a Stripe (action: 'set' para valor absoluto mensual)
      const now = Math.floor(Date.now() / 1000);
      const usageRecord = await stripe.subscriptionItems.createUsageRecord(meteredItem.id, {
        quantity: patientCount,
        timestamp: now,
        action: 'set',
      });

      // Guardar snapshot en billing_usage
      const periodStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      const periodEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0);
      const amountCents = patientCount * sub.price_per_patient_cents;

      await pool.query(
        `INSERT INTO billing_usage (id, therapist_id, period_start, period_end, patient_count, amount_cents, stripe_usage_record_id, reported_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (therapist_id, period_start) DO UPDATE
         SET patient_count = $5, amount_cents = $6, stripe_usage_record_id = $7, reported_at = NOW()`,
        [uuidv4(), sub.therapist_id, periodStart, periodEnd, patientCount, amountCents, usageRecord.id]
      );

      // Registrar evento de billing
      await pool.query(
        `INSERT INTO billing_events (id, therapist_id, event_type, metadata)
         VALUES ($1, $2, 'usage_reported', $3)`,
        [uuidv4(), sub.therapist_id, JSON.stringify({
          patientCount,
          amountCents,
          periodStart: periodStart.toISOString().slice(0, 10),
          periodEnd: periodEnd.toISOString().slice(0, 10),
          stripeSubscriptionItemId: meteredItem.id,
        })]
      );

      reported++;
      logger.info('Uso reportado a Stripe', {
        therapistId: sub.therapist_id,
        patientCount,
        amountCents,
      });
    } catch (err) {
      errors++;
      logger.error('Error reportando uso para terapeuta', {
        error: err.message,
        therapistId: sub.therapist_id,
      });
    }
  }

  logger.info('Reporte mensual completado', { reported, skipped, errors });
  return { reported, skipped, errors };
}

function verifyWebhook(rawBody, signature) {
  const stripe = getStripe();
  if (!stripe) return null;

  const webhookSecret = config.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    logger.error('STRIPE_WEBHOOK_SECRET no configurado');
    return null;
  }

  try {
    const event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    return event;
  } catch (err) {
    logger.error('Firma de webhook inválida', { error: err.message });
    return null;
  }
}

module.exports = {
  getStripe,
  createStripeCustomer,
  createCheckoutSession,
  verifyWebhook,
  reportMonthlyUsage,
};
