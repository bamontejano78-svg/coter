-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 013 — Widget interactive exercise kinds
-- ═══════════════════════════════════════════════════════════════════════════
-- Los 9 widgets interactivos (Cognitiva, Conductual, Exposición) insertan
-- filas en exercise_sessions con exercise_kind que empieza por 'widget_'.
-- La constraint original solo permitía los 4 valores clínicos.
--
-- Usamos un bloque DO para encontrar y eliminar TODAS las constraints CHECK
-- sobre exercise_sessions.exercise_kind (pueden tener nombre auto-generado
-- o nombres heredados de migraciones previas), y luego añadimos una nueva
-- con los 13 valores (4 clínicos + 9 widgets).

DO $$
DECLARE
  rec RECORD;
BEGIN
  -- Eliminar todas las CHECK constraints sobre exercise_sessions que
  -- mencionen exercise_kind en su definición (independientemente de su nombre)
  FOR rec IN
    SELECT con.conname AS constraint_name
    FROM pg_constraint con
    JOIN pg_class tbl ON con.conrelid = tbl.oid
    WHERE tbl.relname = 'exercise_sessions'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%exercise_kind%'
  LOOP
    EXECUTE format('ALTER TABLE exercise_sessions DROP CONSTRAINT IF EXISTS %I', rec.constraint_name);
  END LOOP;

  -- Recrear con los 13 valores (4 clínicos + 9 widgets)
  EXECUTE $sql$
    ALTER TABLE exercise_sessions
      ADD CONSTRAINT chk_exercise_session_kind
      CHECK (exercise_kind IN (
        'classic',
        'thought_record', 'behavioral_activation', 'graded_exposure',
        'widget_thought_record_lite', 'widget_socratic_dialogue',
        'widget_distortion_detective',
        'widget_ba_activity_diary', 'widget_ba_weekly_plan',
        'widget_ba_pleasant_activities',
        'widget_exposure_hierarchy', 'widget_exposure_log',
        'widget_interactive_grounding'
      ))
  $sql$;
END;
$$;
