-- ============================================================
-- Migration 014 — Push notification tokens (FCM)
-- ============================================================
-- Almacena tokens FCM por paciente para que el servidor pueda
-- enviar notificaciones push nativas via Firebase Cloud Messaging.
--
-- Se permite múltiples tokens por paciente (distintos dispositivos).
-- ON CONFLICT (patient_id, token) DO UPDATE mantiene updated_at al día
-- si el mismo dispositivo se re-registra (ej: tras reinstalar la app).

CREATE TABLE IF NOT EXISTS push_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id  UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  token       TEXT NOT NULL,
  platform    VARCHAR(20) DEFAULT 'android',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (patient_id, token)
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_patient ON push_tokens (patient_id);
