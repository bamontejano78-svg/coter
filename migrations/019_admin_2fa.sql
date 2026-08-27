-- Migration 019 — Verificación en dos pasos (2FA TOTP) para el panel de administración
-- El secreto se guarda cifrado con AES-256-GCM (ENCRYPTION_KEY) por la aplicación.
-- Los códigos de respaldo se guardan como hash bcrypt y son de un solo uso.

CREATE TABLE IF NOT EXISTS admin_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_2fa_backup_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash   TEXT NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
