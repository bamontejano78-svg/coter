-- Migración 005: Alinear tipos de columnas con el dominio real
-- ═══════════════════════════════════════════════════════════════
-- Por que: el schema original (001) usaba TEXT para columnas que
-- conceptualmente son TIMESTAMPTZ y UUID. Esto forzaba coercion en
-- cada query que las comparaba con tipos nativos de PG, y bloqueaba
-- el uso de indices nativamente comparables.
--
--   - assignments.due_date TEXT → TIMESTAMPTZ
--     La app siempre escribe ISO strings (new Date().toISOString()).
--     El cron runAllPendingReminders de utils/taskScheduler hace
--     `due_date::timestamptz <= NOW() + make_interval(...)`; con la
--     columna TIMESTAMPTZ nativa, ese cast desaparece y PG puede usar
--     indice real sobre la columna.
--
--   - notifications.reference_id TEXT → UUID
--     Las rutas crean tareas / goals / messages / etc. via uuidv4() y
--     pasan el string a reference_id. El cron dedup usa
--     `n.reference_id = a.id::text` para comparar contra assignments.id
--     (UUID). Con reference_id como UUID nativo, el cast desaparece y
--     ademas el FK conceptual (reference_id -> tabla referenciada por
--     type) queda alineado con tipos.
--
-- Safe: ambas columnas son NULLABLE. El USING pone NULL cuando el valor
-- legacy no parsea, en vez de matar la migracion entera. Hoy la app solo
-- escribe formatos validos, asi que filas validas se convierten limpias
-- y solo basura muy degradada quedaria como NULL (preferible a fallar
-- deploy en produccion).

-- 1) assignments.due_date TEXT → TIMESTAMPTZ
ALTER TABLE assignments
  ALTER COLUMN due_date TYPE TIMESTAMPTZ
  USING (
    CASE
      WHEN due_date IS NULL THEN NULL
      WHEN due_date ~ '^\d{4}-\d{2}-\d{2}(T|\s)' THEN due_date::timestamptz
      ELSE NULL
    END
  );

-- 2) notifications.reference_id TEXT → UUID
ALTER TABLE notifications
  ALTER COLUMN reference_id TYPE UUID
  USING (
    CASE
      WHEN reference_id IS NULL THEN NULL
      WHEN reference_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        THEN reference_id::uuid
      ELSE NULL
    END
  );

-- 3) Indices nativos sobre las columnas recien tipadas.
--    El cron de reminders hace WHERE due_date <= NOW() + N hours y el
--    dedup WHERE reference_id = ... : ambos Acceleran dramaticamente.

-- Indice parcial sobre assignments.due_date SOLO para tareas pendientes
-- (status='assigned' and due_date IS NOT NULL). Es muchisimo mas
-- compacto que uno completo, y cubre exactamente la query del cron.
CREATE INDEX IF NOT EXISTS idx_assignments_pending_due
  ON assignments(due_date)
  WHERE status = 'assigned' AND due_date IS NOT NULL;

-- Indice parcial sobre notifications.reference_id, tambien usado por
-- el dedup del cron (NOT EXISTS sobre types overdue|reminder).
CREATE INDEX IF NOT EXISTS idx_notifications_reference_id
  ON notifications(reference_id)
  WHERE reference_id IS NOT NULL;
