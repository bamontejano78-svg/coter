-- Migration 017 — Estado de procesamiento de webhooks Stripe
-- Un evento recién reclamado queda en processing. Si el proceso muere,
-- otro worker puede recuperar el evento después de cinco minutos.
ALTER TABLE stripe_webhook_events
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'processed'
    CHECK (status IN ('processing', 'processed'));

ALTER TABLE stripe_webhook_events
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

ALTER TABLE stripe_webhook_events
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_processing
  ON stripe_webhook_events (status, claimed_at);
