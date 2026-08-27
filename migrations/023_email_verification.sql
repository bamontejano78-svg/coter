-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 023 — Verificación de email obligatoria para terapeutas
-- ═══════════════════════════════════════════════════════════════════════════
-- Por qué existe:
--   El modelo freemium (1 paciente gratis) hace que sea trivial crear
--   múltiples cuentas para evadir el pago. La verificación de email obliga
--   a que cada cuenta esté vinculada a un buzón real, incrementando el coste
--   de abuso sin añadir fricción significativa a usuarios legítimos.
--
-- Flujo:
--   1. POST /therapists/register  → crea cuenta + envía email de verificación
--                                   NO emite JWT hasta que el email sea verificado
--   2. GET  /therapists/verify-email?token=<raw> → verifica token, emite JWT
--   3. GET  /therapists/resend-verification      → reenvía si no verificó aún
--
-- Tokens:
--   - Raw: crypto.randomBytes(32).toString('hex') — viaja solo en el email
--   - Hash: SHA-256 del raw — guardado en BD (mismo patrón que password_resets)
--   - TTL: 24 horas (frente a 1 hora del reset de contraseña, porque el
--     terapeuta puede tardar más en revisar el correo profesional)
--   - Un solo token activo por terapeuta (invalidar anteriores al reenviar)
--
-- Cuentas existentes:
--   email_verified_at = NULL → se consideran NO verificadas.
--   Si se despliega sobre una BD con terapeutas existentes que ya confiamos,
--   ejecutar antes del deploy:
--     UPDATE therapists SET email_verified_at = NOW() WHERE email_verified_at IS NULL;
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1) Columna en therapists ─────────────────────────────────────────────
ALTER TABLE therapists
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ DEFAULT NULL;

-- Índice para la query del billingGuard (JOIN / subquery therapist → suscripción)
CREATE INDEX IF NOT EXISTS idx_therapists_email_verified
  ON therapists(id) WHERE email_verified_at IS NULL;

-- ─── 2) Tabla email_verifications ────────────────────────────────────────
-- Misma estructura que password_resets pero con TTL de 24h y
-- invalidación de tokens anteriores al reenviar.
CREATE TABLE IF NOT EXISTS email_verifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  therapist_id  UUID NOT NULL REFERENCES therapists(id) ON DELETE CASCADE,
  token         TEXT UNIQUE NOT NULL,   -- hash SHA-256 del token raw
  expires_at    TIMESTAMPTZ NOT NULL,
  used          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_verifications_therapist
  ON email_verifications(therapist_id);

CREATE INDEX IF NOT EXISTS idx_email_verifications_token
  ON email_verifications(token);
