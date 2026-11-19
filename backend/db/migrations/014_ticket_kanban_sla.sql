-- ============================================
-- 014: Ticket Kanban stage model + SLA tracking (P2-BE2-02)
-- ============================================
--
-- Adds persisted SLA due dates, breach flag and stage-transition history that
-- the ticket Kanban board reads. Every statement is idempotent
-- (`IF NOT EXISTS` / conditional backfill) so the migration is safe to re-run.
-- No raw BEGIN/COMMIT: the migration runner executes statements atomically.

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS first_response_due_at TIMESTAMPTZ;

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS sla_due_at TIMESTAMPTZ;

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS sla_breached BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS stage_history JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Tickets without a computed deadline get the historical default window
-- (4h first response / 48h resolution) measured from their creation time.
UPDATE tickets
SET
  first_response_due_at = COALESCE(
    first_response_due_at,
    created_at + INTERVAL '4 hours'
  ),
  sla_due_at = COALESCE(sla_due_at, created_at + INTERVAL '48 hours')
WHERE first_response_due_at IS NULL OR sla_due_at IS NULL;

-- Legacy rows whose stage is already Resolved/Closed must carry a resolution
-- stamp and a terminal history entry so the SLA engine does not flag them.
UPDATE tickets
SET
  resolved_at = COALESCE(resolved_at, updated_at, created_at, NOW()),
  closed_at = CASE
    WHEN stage = 'Closed' THEN COALESCE(closed_at, updated_at, created_at, NOW())
    ELSE closed_at
  END,
  stage_history = CASE
    WHEN stage_history = '[]'::jsonb OR stage_history IS NULL
      THEN jsonb_build_array(
        jsonb_build_object(
          'stage',
          stage,
          'at',
          COALESCE(updated_at, created_at, NOW())
        )
      )
    ELSE stage_history
  END
WHERE stage IN ('Resolved', 'Closed');

CREATE INDEX IF NOT EXISTS idx_tickets_stage ON tickets(stage);
CREATE INDEX IF NOT EXISTS idx_tickets_sla_breached ON tickets(sla_breached);
CREATE INDEX IF NOT EXISTS idx_tickets_sla_due_at ON tickets(sla_due_at);
CREATE INDEX IF NOT EXISTS idx_tickets_first_response_due_at
  ON tickets(first_response_due_at);
