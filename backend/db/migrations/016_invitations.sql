CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'member',
    token_hash TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    invited_by TEXT,
    workspace_id TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS invitations_pending_email_idx
    ON invitations (lower(email))
    WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS invitations_token_hash_idx ON invitations (token_hash);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'invitations_role_check'
    ) THEN
        ALTER TABLE invitations
            ADD CONSTRAINT invitations_role_check
            CHECK (role IN ('admin', 'member', 'viewer'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'invitations_status_check'
    ) THEN
        ALTER TABLE invitations
            ADD CONSTRAINT invitations_status_check
            CHECK (status IN ('pending', 'accepted', 'revoked'));
    END IF;
END $$;

DROP TRIGGER IF EXISTS set_updated_at ON invitations;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON invitations
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
