-- Migración 003: Tabla de refresh tokens para terapeutas
-- Soporta rotación de tokens: cada refresh invalida el anterior y genera uno nuevo

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  therapist_id  UUID NOT NULL REFERENCES therapists(id) ON DELETE CASCADE,
  token         TEXT UNIQUE NOT NULL,
  family        TEXT NOT NULL,       -- agrupa tokens de la misma "sesión" para detección de robo
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked       BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_therapist ON refresh_tokens(therapist_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(family);
