-- ============================================
-- Webhook delivery attempt log (every ping)
-- ============================================

CREATE TABLE IF NOT EXISTS webhook_delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
  attempt_number INT NOT NULL,
  status VARCHAR(20) NOT NULL, -- success | failed
  http_status INT,
  message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_delivery_attempt_event
  ON webhook_delivery_attempts (event_id, created_at DESC);