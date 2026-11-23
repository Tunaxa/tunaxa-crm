CREATE INDEX IF NOT EXISTS idx_activities_metadata_message_id
  ON activities ((metadata->>'messageId'))
  WHERE metadata->>'messageId' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_activities_metadata_in_reply_to
  ON activities ((metadata->>'inReplyTo'))
  WHERE metadata->>'inReplyTo' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_activities_custom_fields_message_id
  ON activities ((custom_fields->>'messageId'))
  WHERE custom_fields->>'messageId' IS NOT NULL;