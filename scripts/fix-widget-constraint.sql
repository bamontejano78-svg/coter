-- Drop ALL exercise_kind CHECK constraints on exercise_sessions (regardless of name)
-- and recreate with expanded list including all 9 widget kinds.
-- Run BEFORE integration tests.

DO $$
DECLARE
  rec RECORD;
BEGIN
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
