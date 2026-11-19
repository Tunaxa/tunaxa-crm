-- Migration 013: custom pipeline definitions
--
-- Stores tenant-scoped pipeline definitions so a workspace can define more than
-- one pipeline, each with its own ordered stage list and probability matrix.
-- Deals reference a definition through deals.pipeline_id (added in 004/005);
-- no schema change to deals is needed here.
--
-- Transaction control is deliberately absent. backend/db/migrate.js wraps each
-- pending migration and its schema_migrations row in a single transaction, so
-- an explicit BEGIN/COMMIT would nest transactions and break atomicity.
--
-- Every statement is IF NOT EXISTS, matching 004-012, so re-running this
-- migration is a no-op.

CREATE TABLE IF NOT EXISTS pipeline_definitions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'deal',
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  stages JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every read is scoped by workspace_id. This index keeps that lookup indexed
-- as the number of definitions grows.
CREATE INDEX IF NOT EXISTS idx_pipeline_definitions_workspace_id
  ON pipeline_definitions (workspace_id);

-- A tenant may have at most one default definition per entity type. The route
-- clears the existing default before promoting a new one, so the unique index
-- never rejects a legitimate default switch.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_definitions_default
  ON pipeline_definitions (workspace_id, entity_type)
  WHERE is_default;
