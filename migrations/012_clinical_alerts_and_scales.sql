-- ════════════════════════════════════════════════════════════════════════
-- Migration 012: Clinical Alerts + Clinical Scales (PHQ-9, GAD-7, BDI-II)
-- ════════════════════════════════════════════════════════════════════════

-- ─── 1. Clinical Alerts table ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinical_alerts (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  therapist_id  UUID NOT NULL REFERENCES therapists(id) ON DELETE CASCADE,
  patient_id    UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  alert_type    TEXT NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  message       TEXT NOT NULL,
  data          JSONB DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  is_read       BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged_at TIMESTAMPTZ,
  resolved_at   TIMESTAMPTZ,
  resolution_note TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE clinical_alerts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE clinical_alerts ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
ALTER TABLE clinical_alerts ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE clinical_alerts ADD COLUMN IF NOT EXISTS resolution_note TEXT;

ALTER TABLE clinical_alerts DROP CONSTRAINT IF EXISTS clinical_alerts_status_check;
ALTER TABLE clinical_alerts ADD CONSTRAINT clinical_alerts_status_check
  CHECK (status IN ('open', 'acknowledged', 'resolved'));

-- Indices for fast lookups
CREATE INDEX IF NOT EXISTS idx_clinical_alerts_therapist_unread
  ON clinical_alerts (therapist_id, is_read, created_at DESC)
  WHERE is_read = FALSE;

CREATE INDEX IF NOT EXISTS idx_clinical_alerts_therapist_status
  ON clinical_alerts (therapist_id, status, created_at DESC)
  WHERE status <> 'resolved';

CREATE INDEX IF NOT EXISTS idx_clinical_alerts_patient
  ON clinical_alerts (patient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_clinical_alerts_type
  ON clinical_alerts (alert_type, created_at DESC);

-- Dedup: same alert type for same patient within 1h is suppressed
-- (prevents cron-overlap noise from generating duplicate alerts)
CREATE INDEX IF NOT EXISTS idx_clinical_alerts_dedup
  ON clinical_alerts (patient_id, alert_type, created_at);

-- ─── 2. Update CHECK constraints for new exercise_kinds ────────────

-- Update task_templates CHECK
ALTER TABLE task_templates DROP CONSTRAINT IF EXISTS task_templates_exercise_kind_check;
ALTER TABLE task_templates ADD CONSTRAINT task_templates_exercise_kind_check
  CHECK (exercise_kind IN ('classic', 'thought_record', 'behavioral_activation', 'graded_exposure', 'phq9', 'gad7', 'bdiii'));

-- Update assignments CHECK
ALTER TABLE assignments DROP CONSTRAINT IF EXISTS assignments_exercise_kind_check;
ALTER TABLE assignments ADD CONSTRAINT assignments_exercise_kind_check
  CHECK (exercise_kind IN ('classic', 'thought_record', 'behavioral_activation', 'graded_exposure', 'phq9', 'gad7', 'bdiii'));

-- Update exercise_sessions CHECK
ALTER TABLE exercise_sessions DROP CONSTRAINT IF EXISTS exercise_sessions_exercise_kind_check;
ALTER TABLE exercise_sessions ADD CONSTRAINT exercise_sessions_exercise_kind_check
  CHECK (exercise_kind IN ('classic', 'thought_record', 'behavioral_activation', 'graded_exposure', 'phq9', 'gad7', 'bdiii'));

-- Update billing_events CHECK (add alert_generated, scale_completed)
ALTER TABLE billing_events DROP CONSTRAINT IF EXISTS billing_events_event_type_check;
ALTER TABLE billing_events ADD CONSTRAINT billing_events_event_type_check
  CHECK (event_type IN (
    'patient_added', 'patient_removed', 'invoice_created', 'payment_succeeded',
    'payment_failed', 'trial_started', 'trial_ended', 'plan_changed',
    'subscription_canceled', 'subscription_reactivated',
    'subscription_active', 'subscription_past_due', 'checkout_session_created',
    'usage_reported', 'pioneer_activated', 'alert_generated', 'scale_completed'
  ));
