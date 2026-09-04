ALTER TABLE crm_objects ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(100) DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_crm_objects_workspace ON crm_objects(workspace_id);

ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(100) DEFAULT 'default';

ALTER TABLE property_definitions ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(100) DEFAULT 'default';

UPDATE crm_objects SET workspace_id = 'default' WHERE workspace_id IS NULL;
UPDATE webhook_subscriptions SET workspace_id = 'default' WHERE workspace_id IS NULL;
UPDATE property_definitions SET workspace_id = 'default' WHERE workspace_id IS NULL;
