-- ============================================
-- 010: Ticket Kanban stage model + SLA tracking (P2-BE2-02)
-- ============================================
--
-- Adds the persisted SLA due dates, breach flag and stage-transition history the
-- ticket Kanban board reads. Every statement is idempotent (`IF NOT EXISTS`) so
-- the migration is safe to re-run against a database where a developer applied
-- part of it by hand; the runner still records it in schema_migrations once.
--
--   first_response_due_at  when the first agent response is due (priority SLA)
--   sla_due_at             when the ticket should be resolved (priority SLA)
--   sla_breached           persisted resolution-breach flag, refreshed on writes
--   closed_at              when a ticket entered the terminal Closed stage
--   stage_history          ordered [{ stage, at, by, from }] transition log

BEGIN;

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS first_response_due_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_due_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_breached BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS stage_history JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_tickets_sla_due ON tickets (sla_due_at);
CREATE INDEX IF NOT EXISTS idx_tickets_first_response_due ON tickets (first_response_due_at);
CREATE INDEX IF NOT EXISTS idx_tickets_sla_breached ON tickets (sla_breached);

COMMIT;
