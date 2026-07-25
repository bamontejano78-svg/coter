/**
 * ═══════════════════════════════════════════════════════════════
 * Rutas de facturación — Coter Pro
 *
 * Endpoints (Fase 2 — con Stripe):
 *   GET  /status         → estado actual de la suscripción
 *   GET  /usage          → uso del mes actual (pacientes, costo estimado)
 *   POST /create-checkout → crear Stripe Checkout Session y devolver URL
 *   POST /webhook         → recibir eventos de Stripe (webhook)
 * ═══════════════════════════════════════════════════════════════
 */

const express = require('express');
const { getPool } = require('../database');
const { authenticateToken } = require('../middleware/auth');
const {
  isTrialActive,
  countActivePatients,
  transitionSubscription,
  findTherapistByStripeCustomer,
  logBillingEvent,
  claimStripeEvent,
} = require('../utils/billing');
const { createCheckoutSession, verifyWebhook } = require('../utils/stripe');
const logger = require('../config/logger');
const config = require('../config/env');

const router = express.Router();

// ─── GET /status ──────────────────────────────────────────────
// Devuelve el estado actual de la suscripción del terapeuta.
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const therapistId = req.user.id;

    const { rows } = await pool.query(
      'SELECT * FROM subscriptions WHERE therapist_id = $1',
      [therapistId]
    );

    if (rows.length === 0) {
      return res.json({
        success: false,
        error: 'No se encontró suscripción',
        code: 'NO_SUBSCRIPTION',
      });
    }

    const sub = rows[0];
    const patientCount = await countActivePatients(pool, therapistId);

    const trial = sub.status === 'trialing'
      ? await isTrialActive(pool, therapistId)
      : null;

    res.json({
      success: true,
      subscription: {
        status: sub.status,
        pricePerPatientCents: sub.price_per_patient_cents,
        patientCount,
        estimatedMonthlyCostCents: patientCount * sub.price_per_patient_cents,
        isPioneer: sub.is_pioneer === true,
        priceLockedUntil: sub.price_locked_until || null,
        currentPeriodStart: sub.current_period_start,
        currentPeriodEnd: sub.current_period_end,
        trial: trial ? {
          active: trial.active,
          endsAt: trial.endsAt,
          daysLeft: trial.daysLeft,
        } : null,
        stripeCustomerId: sub.stripe_customer_id || null,
        stripeSubscriptionId: sub.stripe_subscription_id || null,
      },
    });
  } catch (err) {
    logger.error('Error en GET /billing/status', { error: err.message });
    res.status(500).json({ success: false, error: 'Error al consultar suscripción' });
  }
});

// ─── GET /usage ───────────────────────────────────────────────
// Devuelve el desglose de uso: cuántos pacientes activos y costo estimado.
router.get('/usage', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const therapistId = req.user.id;

    const patientCount = await countActivePatients(pool, therapistId);

    const { rows: subRows } = await pool.query(
      'SELECT price_per_patient_cents FROM subscriptions WHERE therapist_id = $1',
      [therapistId]
    );
    const priceCents = subRows.length > 0
      ? subRows[0].price_per_patient_cents
      : 300;

    res.json({
      success: true,
      usage: {
        activePatients: patientCount,
        pricePerPatientCents: priceCents,
        estimatedMonthlyCostCents: patientCount * priceCents,
        period: {
          start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
          end: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59, 999).toISOString(),
        },
      },
    });
  } catch (err) {
    logger.error('Error en GET /billing/usage', { error: err.message });
    res.status(500).json({ success: false, error: 'Error al consultar uso' });
  }
});

// ─── POST /create-checkout ────────────────────────────────────
// Crea una sesión de Stripe Checkout y devuelve la URL para
// que el frontend redirija al terapeuta.
router.post('/create-checkout', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const therapistId = req.user.id;
    const successUrl = req.body.successUrl || `${config.APP_URL}/terapeuta.html?checkout=success`;
    const cancelUrl = req.body.cancelUrl || `${config.APP_URL}/terapeuta.html?checkout=cancel`;

    const session = await createCheckoutSession(pool, therapistId, successUrl, cancelUrl);

    if (!session) {
      return res.status(500).json({
        success: false,
        error: 'No se pudo crear la sesión de pago. Verifica la configuración de Stripe.',
        code: 'CHECKOUT_CREATE_ERROR',
      });
    }

    // Registrar evento de billing
    await logBillingEvent(pool, therapistId, 'checkout_session_created', null, {
      sessionId: session.sessionId,
    });

    res.json({
      success: true,
      checkoutUrl: session.url,
      sessionId: session.sessionId,
    });
  } catch (err) {
    logger.error('Error en POST /billing/create-checkout', { error: err.message });
    res.status(500).json({ success: false, error: 'Error al crear sesión de pago' });
  }
});

// ─── POST /webhook ────────────────────────────────────────────
// Recibe eventos de Stripe y actualiza el estado de las
// suscripciones en la BD.
//
// IMPORTANTE: Este endpoint usa express.raw() en server.js
// (NO express.json()) porque Stripe requiere el body sin
// parsear para verificar la firma del webhook.
router.post('/webhook', async (req, res) => {
  // Si no hay rawBody (middleware no configurado), responder error
  if (!req.body || !Buffer.isBuffer(req.body)) {
    logger.error('Webhook recibido sin raw body — express.raw() no configurado');
    return res.status(500).json({ error: 'Webhook endpoint requiere raw body' });
  }

  const sig = req.headers['stripe-signature'];

  // Verificar firma del webhook
  const event = verifyWebhook(req.body, sig);
  if (!event) {
    return res.status(400).json({ error: 'Firma de webhook inválida' });
  }

  const pool = getPool();
  logger.info('Webhook de Stripe recibido', { type: event.type, id: event.id });

  // ── Idempotencia: evitar procesar el mismo evento dos veces ──
  const isNew = await claimStripeEvent(pool, event.id, event.type);
  if (!isNew) {
    // Evento ya procesado anteriormente — responder 200 para que
    // Stripe no reintente (ya está confirmado)
    return res.json({ received: true, deduplicated: true });
  }

  try {
    switch (event.type) {
      // ── Sesión de checkout completada ──────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object;
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        const therapistId = session.metadata?.therapist_id
          || session.subscription_details?.metadata?.therapist_id;

        // Resolver therapist_id si no viene en metadata
        let resolvedId = therapistId;
        if (!resolvedId && customerId) {
          resolvedId = await findTherapistByStripeCustomer(pool, customerId);
        }

        if (resolvedId) {
          await transitionSubscription(pool, resolvedId, 'active', {
            stripeSubscriptionId: subscriptionId,
          });
          logger.info('Suscripción activada vía checkout.session.completed', {
            therapistId: resolvedId,
            stripeSubscriptionId: subscriptionId,
          });
        } else {
          logger.warn('No se pudo resolver therapist_id para checkout.session.completed', {
            customerId,
            subscriptionId,
          });
        }
        break;
      }

      // ── Pago de factura exitoso ────────────────────────────
      case 'invoice.paid': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const subscriptionId = invoice.subscription;

        const therapistId = await findTherapistByStripeCustomer(pool, customerId);
        if (therapistId) {
          await transitionSubscription(pool, therapistId, 'active', {
            stripeSubscriptionId: subscriptionId,
            currentPeriodStart: invoice.period_start
              ? new Date(invoice.period_start * 1000).toISOString()
              : undefined,
            currentPeriodEnd: invoice.period_end
              ? new Date(invoice.period_end * 1000).toISOString()
              : undefined,
          });
          logger.info('Factura pagada — suscripción activa', {
            therapistId,
            invoiceId: invoice.id,
          });
        }
        break;
      }

      // ── Pago de factura fallido ────────────────────────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const subscriptionId = invoice.subscription;

        const therapistId = await findTherapistByStripeCustomer(pool, customerId);
        if (therapistId) {
          await transitionSubscription(pool, therapistId, 'past_due', {
            stripeSubscriptionId: subscriptionId,
          });
          logger.info('Factura impagada — suscripción en past_due', {
            therapistId,
            invoiceId: invoice.id,
          });
        }
        break;
      }

      // ── Suscripción cancelada ──────────────────────────────
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        const therapistId = await findTherapistByStripeCustomer(pool, customerId);
        if (therapistId) {
          await transitionSubscription(pool, therapistId, 'canceled');
          logger.info('Suscripción cancelada', {
            therapistId,
            stripeSubscriptionId: subscription.id,
          });
        }
        break;
      }

      // ── Eventos no manejados ───────────────────────────────
      default: {
        logger.info('Evento de Stripe no manejado', { type: event.type });
      }
    }

    res.json({ received: true });
  } catch (err) {
    logger.error('Error procesando webhook de Stripe', {
      error: err.message,
      eventType: event.type,
    });
    // Siempre respondemos 200 a Stripe para evitar reintentos
    // (Stripe reintentará si devolvemos códigos 4xx/5xx)
    res.json({ received: true, error: 'processed with errors' });
  }
});

module.exports = router;
