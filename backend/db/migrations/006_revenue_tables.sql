-- Migration 006: revenue tables (products, quotes, contracts, orders, invoices, expenses)
--
-- Type choices mirror 004_contacts_leads.sql and 005_core_entities.sql and are
-- forced by the existing API/test contract, not chosen for preference:
--
--   id is TEXT, not UUID.
--     The /api/:resource routes must answer 404 for a missing record. A UUID
--     column raises 22P02 "invalid input syntax for type uuid" for a non-UUID
--     path segment, which surfaces as a 500 instead. TEXT keeps arbitrary
--     legacy string keys addressable while new rows still default to a
--     generated UUID string.
--
--   Every monetary column is DOUBLE PRECISION, not NUMERIC.
--     node-postgres parses NUMERIC into a JS string by default, and the contract
--     asserts JSON numbers (expect(res.body.total).toBe(1234.5)). NUMERIC would
--     also make SUM() return a string in the reports and dashboard aggregates.
--
--   *_id columns are plain TEXT with no foreign key, matching 004 and 005.
--     Migrations 001-003 define no deals/companies/contacts/quotes tables to
--     reference, and the legacy JSON store keys records with prefixed strings
--     (deal_..., company_...) that a UUID foreign key would reject. The same
--     reasoning applies to workspace_id.
--
--   All date columns are TIMESTAMP WITH TIME ZONE, not DATE.
--     The legacy store mixes bare dates ('2026-09-10') and full ISO instants on
--     the same fields, and a timestamptz column accepts both. A DATE column
--     would silently drop the time component and shift the value in time zones
--     behind UTC.
--
-- custom_fields JSONB is not decoration: it is the overflow bag for the legacy
-- camelCase fields that have no column here (quotes/orders/invoices customer
-- details, expenses receipt flags, ...). The alternative - a column per field
-- written anywhere in the app - is unbounded.
--
-- items JSONB holds quote/order/invoice line items. The legacy store uses both
-- `items` and `lineItems` depending on the entity and the writer, so the
-- migration script normalizes either into this one column.
--
-- No repository or route is wired to these tables yet. They exist so the
-- revenue data has a typed home in Postgres; the routes still read the JSON
-- store until a follow-up migration moves them, exactly as 003/004/005 each
-- landed ahead of their route interception.

BEGIN;

-- ============================================
-- products
-- ============================================

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id VARCHAR(100) DEFAULT 'default',
  name TEXT NOT NULL,
  sku TEXT,
  description TEXT,
  price DOUBLE PRECISION,
  cost DOUBLE PRECISION,
  category TEXT,
  active BOOLEAN DEFAULT TRUE,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_workspace ON products (workspace_id);
-- findAll() defaults to ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS idx_products_created ON products (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_name ON products (name);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products (sku);

DROP TRIGGER IF EXISTS trg_products_updated ON products;
CREATE TRIGGER trg_products_updated
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- quotes
-- ============================================

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id VARCHAR(100) DEFAULT 'default',
  title TEXT NOT NULL,
  quote_number TEXT,
  deal_id TEXT,
  company_id TEXT,
  contact_id TEXT,
  status VARCHAR(50) DEFAULT 'Draft',
  subtotal DOUBLE PRECISION,
  discount DOUBLE PRECISION,
  tax DOUBLE PRECISION,
  total DOUBLE PRECISION,
  expiration_date TIMESTAMP WITH TIME ZONE,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quotes_workspace ON quotes (workspace_id);
CREATE INDEX IF NOT EXISTS idx_quotes_created ON quotes (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_deal ON quotes (deal_id);
CREATE INDEX IF NOT EXISTS idx_quotes_company ON quotes (company_id);
CREATE INDEX IF NOT EXISTS idx_quotes_contact ON quotes (contact_id);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes (status);

DROP TRIGGER IF EXISTS trg_quotes_updated ON quotes;
CREATE TRIGGER trg_quotes_updated
  BEFORE UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- contracts
-- ============================================

CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id VARCHAR(100) DEFAULT 'default',
  title TEXT NOT NULL,
  contract_number TEXT,
  deal_id TEXT,
  company_id TEXT,
  contact_id TEXT,
  quote_id TEXT,
  status VARCHAR(50) DEFAULT 'Draft',
  value DOUBLE PRECISION,
  start_date TIMESTAMP WITH TIME ZONE,
  end_date TIMESTAMP WITH TIME ZONE,
  terms TEXT,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contracts_workspace ON contracts (workspace_id);
CREATE INDEX IF NOT EXISTS idx_contracts_created ON contracts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contracts_deal ON contracts (deal_id);
CREATE INDEX IF NOT EXISTS idx_contracts_company ON contracts (company_id);
CREATE INDEX IF NOT EXISTS idx_contracts_quote ON contracts (quote_id);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts (status);

DROP TRIGGER IF EXISTS trg_contracts_updated ON contracts;
CREATE TRIGGER trg_contracts_updated
  BEFORE UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- orders
-- ============================================

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id VARCHAR(100) DEFAULT 'default',
  order_number TEXT,
  deal_id TEXT,
  company_id TEXT,
  contact_id TEXT,
  quote_id TEXT,
  contract_id TEXT,
  status VARCHAR(50) DEFAULT 'Pending',
  total DOUBLE PRECISION,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_workspace ON orders (workspace_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_deal ON orders (deal_id);
CREATE INDEX IF NOT EXISTS idx_orders_quote ON orders (quote_id);
CREATE INDEX IF NOT EXISTS idx_orders_contract ON orders (contract_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);

DROP TRIGGER IF EXISTS trg_orders_updated ON orders;
CREATE TRIGGER trg_orders_updated
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- invoices
-- ============================================

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id VARCHAR(100) DEFAULT 'default',
  invoice_number TEXT,
  order_id TEXT,
  deal_id TEXT,
  company_id TEXT,
  contact_id TEXT,
  status VARCHAR(50) DEFAULT 'Draft',
  total DOUBLE PRECISION,
  due_date TIMESTAMP WITH TIME ZONE,
  paid_at TIMESTAMP WITH TIME ZONE,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_workspace ON invoices (workspace_id);
CREATE INDEX IF NOT EXISTS idx_invoices_created ON invoices (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_order ON invoices (order_id);
CREATE INDEX IF NOT EXISTS idx_invoices_deal ON invoices (deal_id);
CREATE INDEX IF NOT EXISTS idx_invoices_due ON invoices (due_date);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status);

DROP TRIGGER IF EXISTS trg_invoices_updated ON invoices;
CREATE TRIGGER trg_invoices_updated
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- expenses
-- ============================================

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id VARCHAR(100) DEFAULT 'default',
  title TEXT NOT NULL,
  category VARCHAR(100),
  amount DOUBLE PRECISION,
  date TIMESTAMP WITH TIME ZONE,
  vendor TEXT,
  deal_id TEXT,
  company_id TEXT,
  user_id TEXT,
  notes TEXT,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expenses_workspace ON expenses (workspace_id);
CREATE INDEX IF NOT EXISTS idx_expenses_created ON expenses (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses (category);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses (date);
CREATE INDEX IF NOT EXISTS idx_expenses_deal ON expenses (deal_id);
CREATE INDEX IF NOT EXISTS idx_expenses_company ON expenses (company_id);

DROP TRIGGER IF EXISTS trg_expenses_updated ON expenses;
CREATE TRIGGER trg_expenses_updated
  BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
