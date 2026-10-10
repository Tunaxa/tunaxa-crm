-- ============================================
-- 011: Persistent user preferences (P2-BE1-04)
-- ============================================
--
-- The API reads and writes preferences on the authenticated user record in the
-- JSON store (backend/store.js), because that is the source of truth
-- middleware/auth.js uses to build `req.user`. This migration defines the
-- equivalent relational shape so the Postgres deployment path has a canonical
-- table to move to when the user/auth store is migrated, and so a Postgres
-- reader never has to invent the schema.
--
--   user_id           the authenticated user id (TEXT: the JSON store uses
--                     opaque `usr_...` ids, so there is intentionally no FK to
--                     the UUID-keyed `users` table)
--   theme             'light' | 'dark' | 'system'
--   density           'compact' | 'comfortable' | 'spacious'
--   column_visibility { <resource>: string[] | boolean }
--   updated_at        last write, refreshed by trigger
--
-- Every statement is idempotent (`IF NOT EXISTS`, guarded constraints) so the
-- migration is safe to re-run against a database where part of it was applied
-- by hand; the runner still records it in schema_migrations once.

BEGIN;

CREATE TABLE IF NOT EXISTS user_preferences (
    user_id TEXT PRIMARY KEY,
    theme VARCHAR(20) NOT NULL DEFAULT 'system',
    density VARCHAR(20) NOT NULL DEFAULT 'comfortable',
    column_visibility JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_preferences_theme_check'
    ) THEN
        ALTER TABLE user_preferences
            ADD CONSTRAINT user_preferences_theme_check
            CHECK (theme IN ('light', 'dark', 'system'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_preferences_density_check'
    ) THEN
        ALTER TABLE user_preferences
            ADD CONSTRAINT user_preferences_density_check
            CHECK (density IN ('compact', 'comfortable', 'spacious'));
    END IF;
END $$;

DROP TRIGGER IF EXISTS set_updated_at ON user_preferences;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON user_preferences
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

COMMIT;
