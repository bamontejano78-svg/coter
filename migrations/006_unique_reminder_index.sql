-- Migration 006: unique constraint para ON CONFLICT del batch INSERT
-- ══════════════════════════════════════════════════════════════════
-- Por que: runAllPendingReminders hace SELECT+INSERT en dos pasos. Entre
-- esos pasos hay una ventana TOCTOU donde otro worker (cron duplicado, N
-- pods corriendo el scheduler, futuro leader-election) puede insertar la
-- misma notification y burlar el dedup NOT EXISTS. Para cerrar esa carrera
-- sin migrar a leader-election ya, anadimos un UNIQUE constraint parcial en
-- BD y usamos ON CONFLICT DO NOTHING en el INSERT multi-VALUES.
--
-- Por que parcial: la unicidad SOLO aplica a types overdue|reminder (los
-- que cron crea). Notifications de tipo 'message', 'assignment', 'goal',
-- 'system' pueden compartir reference_id legítimamente (ej: una tarea y un
-- mensaje sobre la misma tarea) sin generar conflicto espurio.
--
-- Colisiones permitidas (no enforced):
--   - Misma (patient_id, reference_id) con tipos distintos: NOT allowed:
--     el constraint las cubre. Mas especificamente, si reference_id = X
--     con type='overdue' existe, intentar insertar (X, 'reminder')
--     tambien colisionara porque type esta en la constraint. Esto es OK
--     porque conceptualmente tienen el mismo rol semantico.
--   - Mismo (patient_id, reference_id=NULL): permitido (filter WHERE type IN).
--
-- Cobertura: el constraint coincide EXACTAMENTE con el filter de dedup:
-- WHERE type IN ('overdue', 'reminder') en ambos lados. ON CONFLICT recive
-- el predicate matching para que pg pueda usar el indice correctamente.
--
-- ⚠ Si modificas la WHERE predicate en este indice, debes modificar el
-- ON CONFLICT del INSERT en utils/notifications.js al MISMO predicado.
-- Si divergen, PG acepta este indice pero luego emite error "no unique or
-- exclusion constraint matching the ON CONFLICT specification" en runtime.
--
-- ⚠ Esta migration asume que migrations/005_alter_types.sql ya corrio
-- (notifications.reference_id debe ser UUID). El runner las aplica en
-- orden lexicografico (005 < 006), pero en un deploy manual que rompa
-- ese orden, fallara con "column reference_id is not of type uuid".

CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_pending_reminder
  ON notifications(patient_id, reference_id, type)
  WHERE type IN ('overdue', 'reminder');
