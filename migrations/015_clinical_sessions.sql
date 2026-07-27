-- ============================================================
-- Migration 015 — Clinical sessions (registro de sesiones clínicas)
-- ============================================================
-- Añade el concepto de "sesión clínica" como entidad diferenciada
-- de las notas SOAP. Una sesión puede tener múltiples notas SOAP
-- vinculadas (ej: una nota durante la sesión y otra post-sesión).
--
-- Las notas existentes sin session_id siguen funcionando (backward
-- compatible). La nueva UI agrupa notas por sesión.

-- 1. Tabla de sesiones clínicas
CREATE TABLE IF NOT EXISTS clinical_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id      UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  therapist_id    UUID NOT NULL REFERENCES therapists(id) ON DELETE CASCADE,
  session_date    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duration_min    INTEGER,           -- duración en minutos
  type            VARCHAR(30) DEFAULT 'presencial',  -- presencial | videollamada | telefonica | online_chat
  status          VARCHAR(20) DEFAULT 'completed',   -- scheduled | completed | cancelled
  notes_summary   TEXT,              -- resumen opcional de la sesión
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinical_sessions_patient ON clinical_sessions (patient_id);
CREATE INDEX IF NOT EXISTS idx_clinical_sessions_therapist ON clinical_sessions (therapist_id);
CREATE INDEX IF NOT EXISTS idx_clinical_sessions_date ON clinical_sessions (session_date DESC);

-- 2. Vincular notas SOAP a sesiones (nullable para backward compat)
ALTER TABLE clinical_notes
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES clinical_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_clinical_notes_session ON clinical_notes (session_id);
