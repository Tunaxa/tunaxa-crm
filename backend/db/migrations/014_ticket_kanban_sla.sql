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

UPDATE tickets
SET
  first_response_due_at = COALESCE(
    first_response_due_at,
    created_at + INTERVAL '4 hours'
  ),
  sla_due_at = COALESCE(sla_due_at, created_at + INTERVAL '48 hours')
WHERE first_response_due_at IS NULL OR sla_due_at IS NULL;

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