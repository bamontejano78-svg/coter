-- ═══════════════════════════════════════════════════════════
-- Migración 016: Push tokens para terapeutas
-- ═══════════════════════════════════════════════════════════
-- Añade therapist_id a push_tokens (nullable) para que los
-- terapeutas también puedan registrar sus dispositivos FCM.
-- patient_id pasa a ser nullable. CHECK asegura que al menos
-- uno de los dos esté presente.

BEGIN;

-- 1. Hacer patient_id nullable (actualmente es NOT NULL)
ALTER TABLE push_tokens
  ALTER COLUMN patient_id DROP NOT NULL;

-- 2. Añadir therapist_id
ALTER TABLE push_tokens
  ADD COLUMN IF NOT EXISTS therapist_id UUID
  REFERENCES therapists(id) ON DELETE CASCADE;

-- 3. CHECK: al menos uno de los dos IDs debe estar presente
--    (evitamos registros huérfanos que no pertenecen a nadie)
ALTER TABLE push_tokens
  ADD CONSTRAINT chk_push_token_owner
  CHECK (patient_id IS NOT NULL OR therapist_id IS NOT NULL);

-- 4. El UNIQUE index actual es ON (patient_id, token).
--    Lo reemplazamos por uno que cubra ambos casos.
--    patient_id solo se usa si therapist_id IS NULL.
ALTER TABLE push_tokens
  DROP CONSTRAINT IF EXISTS push_tokens_patient_id_token_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_push_tokens_owner_token
  ON push_tokens (COALESCE(patient_id::text, therapist_id::text), token);

COMMIT;
