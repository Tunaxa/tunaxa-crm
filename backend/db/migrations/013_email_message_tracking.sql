-- Inbound IMAP sync stores the RFC message id on the timeline activity it
-- creates (activities.metadata.messageId / metadata.inReplyTo). Deduplication
-- ("have we already recorded this message?") and thread reconstruction
-- ("which activity does this reply belong to?") both look those values up per
-- workspace on every poll, so they need their own indexes - idx_activities_workspace
-- alone turns a repeated mailbox poll into a sequential scan of the table.
--
-- The predicates mirror the queries in services/imapSync.js exactly: the
-- expression indexes cover `metadata->>'messageId' = $n` equality checks, and
-- the partial clause keeps rows that never carried a message id (notes, calls,
-- system events) out of the index entirely.
--
-- Idempotent, like every other migration in this directory, so the runner can
-- safely re-apply the whole set.

CREATE INDEX IF NOT EXISTS idx_activities_metadata_message_id
  ON activities ((metadata->>'messageId'))
  WHERE metadata->>'messageId' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_activities_metadata_in_reply_to
  ON activities ((metadata->>'inReplyTo'))
  WHERE metadata->>'inReplyTo' IS NOT NULL;

-- Same lookup path through the custom_fields overflow bag, which is the other
-- place a message id may live for records created before metadata carried it.
CREATE INDEX IF NOT EXISTS idx_activities_custom_fields_message_id
  ON activities ((custom_fields->>'messageId'))
  WHERE custom_fields->>'messageId' IS NOT NULL;
