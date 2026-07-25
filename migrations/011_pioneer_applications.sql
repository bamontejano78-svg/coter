-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 011 — Solicitudes al Programa Pionero
-- ═══════════════════════════════════════════════════════════════════════════
-- Por qué existe:
--   La campaña "100 Pioneros de COTER" necesita un formulario público donde
--   los terapeutas interesados puedan solicitar acceso. Las solicitudes se
--   guardan en esta tabla y se notifican por email al equipo de COTER para
--   su revisión y aprobación manual.
--
--   Estados:
--     'pending'  → sin revisar (default)
--     'approved' → aceptado como pionero
--     'rejected' → rechazado
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pioneer_applications (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  specialty   TEXT NOT NULL,
  phone       TEXT,
  message     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pioneer_applications_status
  ON pioneer_applications(status);

CREATE INDEX IF NOT EXISTS idx_pioneer_applications_email
  ON pioneer_applications(email);
