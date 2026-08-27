-- Migration 018 — Verificación en dos pasos (2FA TOTP) para terapeutas
-- El secreto TOTP se guarda cifrado con AES-256-GCM (ENCRYPTION_KEY) por la
-- aplicación; aquí solo se añade la columna y la tabla de códigos de respaldo
-- (guardados como hash bcrypt, de un solo uso).

ALTER TABLE therapists
  ADD COLUMN IF NOT EXISTS two_factor_secret TEXT,
  ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS two_factor_confirmed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS therapist_2fa_backup_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  therapist_id  UUID NOT NULL REFERENCES therapists(id) ON DELETE CASCADE,
  code_hash     TEXT NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_2fa_backup_codes_therapist
  ON therapist_2fa_backup_codes (therapist_id);
