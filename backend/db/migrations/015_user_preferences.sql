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