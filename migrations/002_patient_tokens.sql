-- Migración 002: Añadir token de autenticación para pacientes
-- Permite que la app de paciente use un token en vez del ID plano

ALTER TABLE patients ADD COLUMN IF NOT EXISTS auth_token TEXT UNIQUE;
CREATE INDEX IF NOT EXISTS idx_patients_auth_token ON patients(auth_token);

-- Añadir campo last_active a patients
ALTER TABLE patients ADD COLUMN IF NOT EXISTS last_active TIMESTAMPTZ;

-- Generar tokens para pacientes existentes (evita que se rompan tras el deploy)
UPDATE patients SET auth_token = gen_random_uuid() WHERE auth_token IS NULL;
