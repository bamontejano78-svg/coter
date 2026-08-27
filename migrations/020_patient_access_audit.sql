-- Migration 020 — Auditoría de acceso a fichas clínicas
-- Registra quién (terapeuta) consultó la ficha de qué paciente y cuándo.
-- patient_id sin FK a propósito: la traza debe sobrevivir al borrado RGPD
-- del paciente (derecho de supresión no debe borrar la evidencia de acceso).

CREATE TABLE IF NOT EXISTS patient_access_audit (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  therapist_id  UUID NOT NULL REFERENCES therapists(id) ON DELETE CASCADE,
  patient_id    UUID NOT NULL,
  action        TEXT NOT NULL,
  ip            TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_patient_access_audit_patient
  ON patient_access_audit (patient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_patient_access_audit_therapist
  ON patient_access_audit (therapist_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_patient_access_audit_created
  ON patient_access_audit (created_at DESC);
