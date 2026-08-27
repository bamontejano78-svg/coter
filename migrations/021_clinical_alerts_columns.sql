-- Migration 021 — Reconciliación de clinical_alerts
-- Algunas bases de datos (p. ej. la de desarrollo) se migraron cuando la
-- migración 012 aún no incluía estas columnas, y como 012 ya está registrada
-- en _migrations nunca se re-ejecuta. ADD COLUMN IF NOT EXISTS es idempotente:
-- en bases nuevas es un no-op; en las desactualizadas añade lo que falta.

ALTER TABLE clinical_alerts
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'resolved'));

ALTER TABLE clinical_alerts
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;

ALTER TABLE clinical_alerts
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

ALTER TABLE clinical_alerts
  ADD COLUMN IF NOT EXISTS resolution_note TEXT;
