import net from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closePool } from '../db/pg.js';
import {
  ALL_BENCHMARK_WORKSPACES,
  BENCHMARK_ROWS,
  BENCHMARK_TOTAL_ROWS,
  BENCHMARK_WORKSPACE,
  QUERY_PATTERNS,
  benchmarkRowCounts,
  clearBenchmarkData,
  explainPattern,
  seedBenchmarkData,
} from '../db/tools/index-benchmarks.js';

// Target latency for every pattern, and the plan shape required to get there.
const LATENCY_TARGET_MS = 10.0;

// Seeding 37k rows per table across seven tables is the expensive part of this
// file, so the two hooks get a timeout well past the 30s vitest default. The
// benchmark CLI prints the same numbers in ~40s.
const HOOK_TIMEOUT_MS = 240000;

// Every index migration 012 is expected to create, with the shape that matters.
// Existence alone would not catch an index that was created on the wrong
// columns, so the leading column is asserted too - that is what the planner
// keys on.
const EXPECTED_INDEXES = [
  // Relational pointers that had no index at all.
  ['deals', 'idx_deals_owner_id', 'owner_id'],
  ['contacts', 'idx_contacts_company_id', 'company_id'],
  ['contacts', 'idx_contacts_owner_id', 'owner_id'],
  ['leads', 'idx_leads_owner_id', 'owner_id'],
  ['activities', 'idx_activities_contact_id', 'contact_id'],
  ['activities', 'idx_activities_user_id', 'user_id'],
  ['tasks', 'idx_tasks_contact_id', 'contact_id'],
  ['contracts', 'idx_contracts_contact_id', 'contact_id'],
  ['orders', 'idx_orders_company_id', 'company_id'],
  ['orders', 'idx_orders_contact_id', 'contact_id'],
  ['invoices', 'idx_invoices_company_id', 'company_id'],
  ['invoices', 'idx_invoices_contact_id', 'contact_id'],
  // Composite tenant-listing indexes.
  ['contacts', 'idx_contacts_ws_created', 'workspace_id'],
  ['deals', 'idx_deals_ws_stage_created', 'workspace_id'],
  ['deals', 'idx_deals_ws_owner_created', 'workspace_id'],
  ['deals', 'idx_deals_ws_created_stage', 'workspace_id'],
  ['leads', 'idx_leads_ws_status_created', 'workspace_id'],
  ['activities', 'idx_activities_ws_record_date', 'workspace_id'],
  ['tasks', 'idx_tasks_ws_assigned_status', 'workspace_id'],
  ['tickets', 'idx_tickets_ws_status_priority', 'workspace_id'],
  ['quotes', 'idx_quotes_ws_deal', 'workspace_id'],
  // Partial board indexes.
  ['tasks', 'idx_tasks_open_assigned_due', 'workspace_id'],
  ['tickets', 'idx_tickets_open_priority', 'workspace_id'],
  // Expression indexes for the case-insensitive lookups.
  ['contacts', 'idx_contacts_ws_lower_email', 'workspace_id'],
  ['contacts', 'idx_contacts_ws_lower_name', 'workspace_id'],
  ['contacts', 'idx_contacts_ws_lower_last_name', 'workspace_id'],
  ['leads', 'idx_leads_ws_lower_email', 'workspace_id'],
];

// Pointer columns that must be indexed regardless of whether a FOREIGN KEY
// constraint exists. Migrations 004-006 add these as plain TEXT with no
// constraint on purpose (see the header of 012 for why), so the constraint
// catalog cannot be the only source of truth for "is this indexed".
const POINTER_COLUMNS = [
  ['deals', 'company_id'],
  ['deals', 'contact_id'],
  ['deals', 'owner_id'],
  ['contacts', 'company_id'],
  ['contacts', 'owner_id'],
  ['leads', 'owner_id'],
  ['activities', 'contact_id'],
  ['activities', 'deal_id'],
  ['activities', 'user_id'],
  ['activities', 'record_id'],
  ['tasks', 'contact_id'],
  ['tasks', 'deal_id'],
  ['tasks', 'assigned_to'],
  ['quotes', 'deal_id'],
  ['quotes', 'company_id'],
  ['quotes', 'contact_id'],
  ['contracts', 'quote_id'],
  ['contracts', 'deal_id'],
  ['contracts', 'company_id'],
  ['contracts', 'contact_id'],
  ['goals', 'assigned_to'],
  ['saved_reports', 'workspace_id'],
  ['workflow_runs', 'workflow_id'],
  ['invoices', 'order_id'],
  ['invoices', 'deal_id'],
  ['invoices', 'company_id'],
  ['invoices', 'contact_id'],
  ['orders', 'deal_id'],
  ['orders', 'quote_id'],
  ['orders', 'contract_id'],
  ['orders', 'company_id'],
  ['orders', 'contact_id'],
  ['expenses', 'deal_id'],
  ['expenses', 'company_id'],
];

let pgAvailable = false;
let results = [];

function canReachPostgres(timeoutMs = 1000) {
  const host = process.env.PGHOST || '127.0.0.1';
  const port = Number(process.env.PGPORT || 5432);
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const settle = (reachable) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

beforeAll(async () => {
  pgAvailable = await canReachPostgres();
  if (!pgAvailable) return;

  // Migration 012 has to be applied for any of this to mean anything. A 42P01
  // here means the database is up but unmigrated, which is a real failure and
  // not something to skip past.
  const migrationApplied = await query(
    "SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_deals_owner_id'",
  );
  if (migrationApplied.rowCount === 0) {
    throw new Error(
      'Migration 012 is not applied (idx_deals_owner_id missing). Run `node run-migrations.js` before this suite.',
    );
  }

  // Another file's resetTestDb() may have left nothing behind, but a crashed
  // prior run might have. Start from a known-empty benchmark workspace so the
  // row counts asserted below are exact.
  await clearBenchmarkData();
  await seedBenchmarkData();

  for (const pattern of QUERY_PATTERNS) {
    const natural = await explainPattern(pattern, { repeats: 3 });
    const forced = await explainPattern(pattern, { forceIndex: true, repeats: 1 });
    results.push({
      ...natural,
      forcedIndexNames: forced.indexNames,
      forcedUsedIndexScan: forced.usedIndexScan,
    });
  }
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  if (pgAvailable) {
    await clearBenchmarkData();
    await closePool();
  }
});

describe('migration 012 index coverage', () => {
  it('skips cleanly when no PostgreSQL is reachable', () => {
    if (!pgAvailable) {
      expect(pgAvailable).toBe(false);
      return;
    }
    expect(pgAvailable).toBe(true);
  });

  it('indexes every declared foreign key constraint on a public table', async () => {
    if (!pgAvailable) return;

    // Catalog-driven rather than a hardcoded list, so a future migration that
    // adds a real constraint is covered without editing this file.
    const fks = await query(`
      SELECT c.relname AS table_name, a.attname AS column_name
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON k.ord = 1
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
      WHERE con.contype = 'f' AND n.nspname = 'public'
      ORDER BY c.relname, a.attname
    `);

    const unindexed = [];
    for (const fk of fks.rows) {
      const covered = await query(
        `SELECT 1
           FROM pg_index i
           JOIN pg_class t ON t.oid = i.indrelid
           JOIN pg_class ic ON ic.oid = i.indexrelid
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
          WHERE t.relname = $1
            AND a.attname = $2
            AND i.indisvalid
            AND i.indisready
          LIMIT 1`,
        [fk.table_name, fk.column_name],
      );
      if (covered.rowCount === 0) unindexed.push(`${fk.table_name}.${fk.column_name}`);
    }

    expect(unindexed).toEqual([]);
  });

  it('indexes every relational pointer column, constrained or not', async () => {
    if (!pgAvailable) return;

    const unindexed = [];
    for (const [table, column] of POINTER_COLUMNS) {
      const covered = await query(
        `SELECT 1
           FROM pg_index i
           JOIN pg_class t ON t.oid = i.indrelid
           JOIN pg_class ic ON ic.oid = i.indexrelid
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
          WHERE t.relname = $1 AND a.attname = $2
            AND i.indisvalid AND i.indisready
          LIMIT 1`,
        [table, column],
      );
      if (covered.rowCount === 0) unindexed.push(`${table}.${column}`);
    }

    expect(unindexed).toEqual([]);
  });

  it('creates every composite, partial and expression index on its intended leading column', async () => {
    if (!pgAvailable) return;

    const missing = [];
    for (const [table, index, leading] of EXPECTED_INDEXES) {
      const found = await query(
        `SELECT a.attname AS leading_column
           FROM pg_index i
           JOIN pg_class t ON t.oid = i.indrelid
           JOIN pg_class ic ON ic.oid = i.indexrelid
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
          WHERE t.relname = $1 AND ic.relname = $2
            AND i.indisvalid AND i.indisready`,
        [table, index],
      );
      if (found.rowCount === 0) missing.push(`${table}.${index} (absent)`);
      else if (found.rows[0].leading_column !== leading) {
        missing.push(`${table}.${index} leads with ${found.rows[0].leading_column}, expected ${leading}`);
      }
    }

    expect(missing).toEqual([]);
  });

  it('keeps the expression indexes case-insensitive', async () => {
    if (!pgAvailable) return;

    const definitions = await query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN ('idx_contacts_ws_lower_email', 'idx_contacts_ws_lower_name',
                            'idx_contacts_ws_lower_last_name', 'idx_leads_ws_lower_email')`,
    );
    expect(definitions.rowCount).toBe(4);
    for (const row of definitions.rows) {
      // A plain btree on the raw column cannot serve LOWER(x) = LOWER($1), which
      // is exactly what repositories/contacts.js and leads.js emit.
      expect(row.indexdef).toMatch(/lower\(/);
    }
  });

  it('scopes the partial board indexes to open rows only', async () => {
    if (!pgAvailable) return;

    const partial = await query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN ('idx_tasks_open_assigned_due', 'idx_tickets_open_priority')`,
    );
    expect(partial.rowCount).toBe(2);
    const byName = Object.fromEntries(partial.rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName.idx_tasks_open_assigned_due).toMatch(/WHERE .*completed/);
    expect(byName.idx_tickets_open_priority).toMatch(/WHERE .*resolved_at/);
  });
});

describe('query plans on a 10,000-row workspace', () => {
  it('seeds the requested 10,000 rows in the measured workspace', async () => {
    if (!pgAvailable) return;

    const counts = await benchmarkRowCounts();
    for (const row of counts) {
      expect(row.n).toBe(BENCHMARK_ROWS);
    }
    // Plus decoy tenants, so the workspace_id leading column is discriminating
    // and the planner is choosing indexes the way it would in production.
    expect(BENCHMARK_TOTAL_ROWS).toBeGreaterThan(BENCHMARK_ROWS);
  });

  it('measures exactly the ten documented query patterns', () => {
    expect(QUERY_PATTERNS).toHaveLength(10);
    expect(results).toHaveLength(10);
    expect(results.map((r) => r.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('executes every pattern in under 10 ms', () => {
    if (!pgAvailable) return;

    const slow = results
      .filter((r) => r.executionTimeMs >= LATENCY_TARGET_MS)
      .map((r) => `#${r.id} ${r.label}: ${r.executionTimeMs.toFixed(3)} ms`);
    expect(slow).toEqual([]);
  });

  it('plans every point and listing query with an index scan, never a bare sequential scan', () => {
    if (!pgAvailable) return;

    const seqScanned = results
      .filter((r) => r.nodeTypes.includes('Seq Scan'))
      .map((r) => `#${r.id} ${r.label}: ${r.nodeTypes.join(' > ')}`);
    expect(seqScanned).toEqual([]);
  });

  it('routes the two board queries through the partial indexes added by migration 012', () => {
    if (!pgAvailable) return;

    // Regression guard for the finding that produced idx_tasks_open_assigned_due
    // and idx_tickets_open_priority: with only the plain composites the planner
    // used idx_tasks_workspace / idx_tickets_workspace and sorted ~10k rows,
    // which is how patterns 7 and 8 first measured 4.8 ms and 10.8 ms.
    const seven = results.find((r) => r.id === 7);
    const eight = results.find((r) => r.id === 8);
    expect(seven.indexNames).toContain('idx_tasks_open_assigned_due');
    expect(eight.indexNames).toContain('idx_tickets_open_priority');
  });

  it('routes the pipeline aggregate through the covering index as an index-only scan', () => {
    if (!pgAvailable) return;

    const nine = results.find((r) => r.id === 9);
    // INCLUDE (value) means SUM(value) is answered from the index, so the plan
    // must not need a heap fetch per row.
    expect(nine.indexNames).toContain('idx_deals_ws_created_stage');
    expect(nine.nodeTypes).toContain('Index Only Scan');
  });

  it('serves the case-insensitive lookups from the expression indexes', () => {
    if (!pgAvailable) return;

    const four = results.find((r) => r.id === 4);
    const five = results.find((r) => r.id === 5);
    expect(four.indexNames).toContain('idx_contacts_ws_lower_email');
    expect(five.indexNames).toContain('idx_leads_ws_lower_email');
  });

  it('leaves a usable index path for every pattern even with sequential scans disabled', () => {
    if (!pgAvailable) return;

    // Guards against an index being dropped or rebuilt on the wrong columns: the
    // natural plan may legitimately prefer something else on a table this size,
    // but a forced-index run must always find a path.
    const noPath = results.filter((r) => !r.forcedUsedIndexScan).map((r) => `#${r.id} ${r.label}`);
    expect(noPath).toEqual([]);
  });
});

// Documented limitation, asserted so it stays visible rather than becoming a
// silent surprise: the repositories' real search is a substring ILIKE
// ('%term%'), which no btree can serve. Pattern 4 is therefore written with an
// anchored prefix, which is what the varchar_pattern_ops index supports.
// Making the substring form fast needs pg_trgm, which is an extension install
// (a deployment decision) rather than an index-tuning one, so it is not part
// of migration 012.
describe('known limitation', () => {
  it('does not claim substring search is index-accelerated', async () => {
    if (!pgAvailable) return;

    const before = Date.now();
    await query(
      `SELECT COUNT(*) FROM contacts
        WHERE workspace_id = $1 AND first_name ILIKE '%5000%'`,
      [BENCHMARK_WORKSPACE],
    );
    const elapsed = Date.now() - before;

    // Recorded, not asserted against a threshold: the point is that a
    // substring ILIKE over a tenant still scans, and that is a known gap.
    expect(typeof elapsed).toBe('number');
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });
});

// Last in the file on purpose: it is the only test that needs the benchmark rows
// to be gone, and it performs the teardown itself so the assertion is about
// something that actually happened. afterAll still calls clearBenchmarkData() as
// a safety net for the case where an earlier test threw.
describe('benchmark teardown', () => {
  it('removes every seeded row', async () => {
    if (!pgAvailable) return;

    await clearBenchmarkData();

    const counts = await benchmarkRowCounts();
    for (const row of counts) {
      expect(row.n).toBe(0);
    }

    const strays = await query(
      `SELECT COUNT(*)::int AS n FROM (
         SELECT workspace_id FROM contacts
         UNION ALL SELECT workspace_id FROM deals
         UNION ALL SELECT workspace_id FROM activities
         UNION ALL SELECT workspace_id FROM tasks
         UNION ALL SELECT workspace_id FROM leads
         UNION ALL SELECT workspace_id FROM tickets
         UNION ALL SELECT workspace_id FROM quotes
       ) s WHERE s.workspace_id = ANY($1)`,
      [ALL_BENCHMARK_WORKSPACES],
    );
    expect(strays.rows[0].n).toBe(0);
  }, 120000);
});
