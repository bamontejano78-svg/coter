-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 010 — Sistema de Pioneros (Campaña "100 Pioneros de COTER")
-- ═══════════════════════════════════════════════════════════════════════════
-- Por qué existe:
--   Los primeros 100 terapeutas registrados reciben condiciones exclusivas:
--     • €3/paciente/mes (vs €5 precio estándar futuro)
--     • Precio bloqueado durante 12 meses (price_locked_until)
--     • Badge "Pionero" en el panel de facturación
--
--   is_pioneer       → TRUE si el terapeuta es uno de los 100 pioneros
--   price_locked_until → TIMESTAMPTZ hasta cuándo se garantiza el precio
--                        preferencial. NULL si no es pionero o ya expiró.
--
--   La lógica de asignación está en createTrialSubscription():
--     1. Cuenta pioneros existentes (SELECT COUNT WHERE is_pioneer = true)
--     2. Si count < 100 → INSERT con is_pioneer = true,
--        price_locked_until = NOW() + 12 months
--     3. Si count >= 100 → INSERT con is_pioneer = false (precio estándar)
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Añadir columnas de pionero a subscriptions
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS is_pioneer BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS price_locked_until TIMESTAMPTZ;

-- Índice para el conteo rápido de pioneros al registrar
CREATE INDEX IF NOT EXISTS idx_subscriptions_pioneer
  ON subscriptions(is_pioneer) WHERE is_pioneer = TRUE;

-- 2) Ampliar CHECK constraint de billing_events para incluir pioneer_activated
--    (usado cuando un terapeuta recibe el badge de pionero al registrarse)
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
    'usage_reported',
    -- Pioneros:
    'pioneer_activated'
  ));
