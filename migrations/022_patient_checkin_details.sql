-- ============================================================
-- Migration 022 — richer patient check-ins
-- ============================================================
-- Optional fields keep existing check-ins fully backward compatible.
ALTER TABLE check_ins
  ADD COLUMN IF NOT EXISTS sleep_hours NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS sleep_quality INTEGER,
  ADD COLUMN IF NOT EXISTS emotions TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'check_ins_sleep_hours_valid'
  ) THEN
    ALTER TABLE check_ins ADD CONSTRAINT check_ins_sleep_hours_valid
      CHECK (sleep_hours IS NULL OR (sleep_hours >= 0 AND sleep_hours <= 24));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'check_ins_sleep_quality_valid'
  ) THEN
    ALTER TABLE check_ins ADD CONSTRAINT check_ins_sleep_quality_valid
      CHECK (sleep_quality IS NULL OR (sleep_quality >= 1 AND sleep_quality <= 10));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_check_ins_patient_date ON check_ins(patient_id, created_at DESC);
