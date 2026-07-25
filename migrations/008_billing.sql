-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 008 — Sistema de suscripciones (Stripe metered billing)
-- ═══════════════════════════════════════════════════════════════════════════
-- Por qué existe:
--   Coter cobra una suscripción mensual por paciente activo (tarifa plana).
--   Stripe gestiona los cobros vía metered billing: cada día 1 del mes se
--   reporta el conteo de pacientes activos → Stripe genera la invoice.
--
-- Modelo:
--   • 14 días de trial al registrarse (sin tarjeta)
--   • €X / paciente activo / mes
--   • Pioneros (primeros 100): €3/paciente/mes con precio bloqueado 12 meses
--   • Sin plan gratuito permanente
--
-- Tablas:
--   subscriptions        — plan del terapeuta, link a Stripe, estado
--   billing_usage        — snapshot mensual del conteo de pacientes
--   billing_events       — log inmutable de eventos de facturación
--   therapist_patients   — se añade billing_started_at
--
-- Estados de subscription:
--   'trialing'  → trial de 14 días (sin cobro)
--   'active'    → suscripción activa y pagando
--   'past_due'  → pago fallido, 7 días de gracia
--   'canceled'  → acceso bloqueado al terapeuta (pacientes conservan acceso)
--   'incomplete'→ checkout de Stripe no completado aún (primer pago pendiente)
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1) subscriptions ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  therapist_id        UUID NOT NULL UNIQUE REFERENCES therapists(id) ON DELETE CASCADE,
  stripe_customer_id  TEXT,
  stripe_subscription_id TEXT,
  stripe_price_id     TEXT,
  status              TEXT NOT NULL DEFAULT 'trialing'
                        CHECK (status IN ('trialing','active','past_due','canceled','incomplete')),
  price_per_patient_cents INTEGER NOT NULL DEFAULT 300,  -- 3.00 € (precio pionero)
  trial_ends_at       TIMESTAMPTZ NOT NULL,
  current_period_start TIMESTAMPTZ,
  current_period_end  TIMESTAMPTZ,
  canceled_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_therapist ON subscriptions(therapist_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status   ON subscriptions(status);

-- ─── 2) billing_usage — snapshot mensual reportado a Stripe ──────────────
CREATE TABLE IF NOT EXISTS billing_usage (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  therapist_id        UUID NOT NULL REFERENCES therapists(id) ON DELETE CASCADE,
  period_start        DATE NOT NULL,
  period_end          DATE NOT NULL,
  patient_count       INTEGER NOT NULL,
  amount_cents        INTEGER NOT NULL,
  stripe_usage_record_id TEXT,
  reported_at         TIMESTAMPTZ,
  UNIQUE(therapist_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_billing_usage_therapist ON billing_usage(therapist_id);

-- ─── 3) billing_events — log inmutable de eventos ────────────────────────
CREATE TABLE IF NOT EXISTS billing_events (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  therapist_id        UUID NOT NULL REFERENCES therapists(id) ON DELETE CASCADE,
  event_type          TEXT NOT NULL
                        CHECK (event_type IN (
                          'patient_added','patient_removed','invoice_created',
                          'payment_succeeded','payment_failed','trial_started',
                          'trial_ended','plan_changed','subscription_canceled',
                          'subscription_reactivated'
                        )),
  patient_id          UUID REFERENCES patients(id) ON DELETE SET NULL,
  metadata            JSONB DEFAULT '{}',
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_events_therapist ON billing_events(therapist_id);

-- ─── 4) therapist_patients: añadir billing_started_at ────────────────────
ALTER TABLE therapist_patients
  ADD COLUMN IF NOT EXISTS billing_started_at TIMESTAMPTZ DEFAULT NOW();
