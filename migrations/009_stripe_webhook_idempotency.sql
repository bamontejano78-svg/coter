-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 009 — Idempotencia de webhooks Stripe
-- ═══════════════════════════════════════════════════════════════════════════
-- Por qué existe:
--   Stripe puede reintentar la entrega de webhooks (hasta 3 días con backoff
--   exponencial). Si el mismo evento (mismo event.id) se procesa dos veces,
--   transitionSubscription() corre dos veces y potencialmente corrompe el
--   estado (ej: dos transition a 'canceled' después de una reactivación
--   pueden revertir el estado incorrectamente).
--
-- Solución:
--   Tabla stripe_webhook_events con stripe_event_id PRIMARY KEY. Antes de
--   procesar un webhook, INSERT el event.id de Stripe. Si el INSERT falla
--   por duplicate key, el evento ya fue procesado → skip idempotente.
--
--   Además se amplía el CHECK de billing_events.event_type para cubrir los
--   valores que ya se estaban usando en producción (subscription_active,
--   subscription_past_due, checkout_session_created).
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Tabla ligera para deduplicar eventos de Stripe por event.id.
--    PRIMARY KEY garantiza atomicidad: si dos workers intentan insertar
--    el mismo event.id, PostgreSQL rechaza el segundo con error 23505.
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  stripe_event_id   TEXT PRIMARY KEY,
  event_type        TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- 2) Ampliar CHECK constraint de billing_events para cubrir los event_type
--    que ya se usan en production (transitionSubscription + createCheckout).
ALTER TABLE billing_events
  DROP CONSTRAINT IF EXISTS billing_events_event_type_check;

ALTER TABLE billing_events
  ADD CONSTRAINT billing_events_event_type_check
  CHECK (event_type IN (
    'patient_added','patient_removed','invoice_created',
    'payment_succeeded','payment_failed','trial_started',
    'trial_ended','plan_changed','subscription_canceled',
    'subscription_reactivated',
    -- Fase 2 (Stripe):
    'subscription_active','subscription_past_due',
    'checkout_session_created',
    -- Cron mensual:
    'usage_reported'
  ));
