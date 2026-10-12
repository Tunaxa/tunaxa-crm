-- ============================================
-- 012: Team invitations (P2-BE1-05)
-- ============================================
--
-- The API stores invitations in the JSON store (backend/store.js), because that
-- is the same source of truth middleware/auth.js reads for users and sessions.
-- This migration defines the equivalent relational shape so the Postgres
-- deployment path has a canonical table to move to when the user/auth store is
-- migrated, and so a Postgres reader never has to invent the schema.
--
--   id             opaque `inv_...` id (TEXT, no FK: the JSON store is keyed by
--                  opaque strings, not the UUID `users` table)
--   email          normalized lowercase invitee address
--   role           'admin' | 'member' | 'viewer' (the RBAC roles the app enforces)
--   token_hash     SHA-256 of the raw join token; the raw secret is never stored
--   status         'pending' | 'accepted' | 'revoked'  (`expired` is derived)
--   invited_by     inviter user id
--   expires_at     join-link expiry (created/resend + 7 days)
--   accepted_at    when the invitee accepted
--   created_at/    bookkeeping, updated_at refreshed by trigger
--   updated_at
--
-- Every statement is idempotent (`IF NOT EXISTS`, guarded constraints) so the
-- migration is safe to re-run against a database where part of it was applied
-- by hand; the runner still records it in schema_migrations once.

BEGIN;

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

-- One live join link per address: a pending invite and its replacement cannot
-- both be redeemable at the same time. Accepted/revoked rows are unconstrained
-- so the lifecycle history is retained.
CREATE UNIQUE INDEX IF NOT EXISTS invitations_pending_email_idx
    ON invitations (lower(email))
    WHERE status = 'pending';

-- The token lookup is by hash, which must be unique across every row.
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

COMMIT;
