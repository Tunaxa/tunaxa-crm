-- Migration 008: keep forms.updated_at stable across submissions
--
-- Every table in 004-007 wires update_updated_at_column(), an unconditional
-- `NEW.updated_at = NOW()`. That is right for an edit, but a public form
-- submission bumps forms.submission_count on every visitor, so the shared
-- trigger would restamp updated_at each time. The forms list then shows a
-- submission time under "last modified" instead of the time somebody last
-- changed the form definition, and the timestamp carries no useful signal.
--
-- This adds a forms-local trigger that leaves updated_at alone when the update
-- touches nothing but the counter. Comparing the row as jsonb with the two
-- volatile-ish columns removed keeps the rule declarative: any other change
-- (including an explicit updated_at from a writer that means it) still stamps
-- NOW(), exactly as before.
--
-- Scoped to `forms` on purpose. Changing update_updated_at_column() itself
-- would silently alter the semantics of the other fifteen tables.

BEGIN;

-- Namespaced to forms so a future table with a public counter can copy the
-- pattern instead of reusing it.
CREATE OR REPLACE FUNCTION forms_keep_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  IF (to_jsonb(NEW) - 'submission_count' - 'updated_at')
     IS NOT DISTINCT FROM
     (to_jsonb(OLD) - 'submission_count' - 'updated_at') THEN
    -- Counter-only change: preserve whatever updated_at already was.
    RETURN NEW;
  END IF;
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 007 created trg_forms_updated against the shared function. Recreate the same
-- trigger name so DROP/CREATE stays the established migration idiom.
DROP TRIGGER IF EXISTS trg_forms_updated ON forms;
CREATE TRIGGER trg_forms_updated
  BEFORE UPDATE ON forms
  FOR EACH ROW EXECUTE FUNCTION forms_keep_updated_at();

COMMIT;
