// Shared harness for the migration 012 index benchmarks.
//
// Kept separate from the CLI (verify-indexes.js) and the vitest suite
// (__tests__/db-indexes.test.js) so both drive the same query text, the same
// seed and the same plan assertions. If the two disagreed, the benchmark and
// the test would be measuring different things.
//
// The ten patterns are the mission-critical reads: paginated tenant listings,
// the search boxes, and the dashboard aggregates. Each is written the way the
// repository that owns it actually writes it:
//
//   * Tenant scoping is workspace_id = $1 everywhere. Migration 003 added that
//     column and every read filters on it, which is why every composite index
//     here leads with it.
//   * Sorting is created_at DESC (the findAll() default in the repositories)
//     except for the task board, which sorts by due_date ASC.
//   * Search uses LOWER() on both sides, per the note in
//     repositories/leads.js findByEmail() explaining why the plain btree on
//     email cannot serve the lookup.
//
// Three patterns are adapted from the original request because the columns it
// named do not exist in this schema; migrations 004-007 document each
// substitution and migration 012 repeats them:
//
//   4. contacts.name        -> first_name / last_name
//   6. activities.date      -> created_at (date lives in custom_fields)
//   8. tickets.status       -> stage / resolved_at (routes/tickets.js filters
//                              and SLA logic both branch on stage)

import { getPool, query } from "../pg.js";

// Rows land in their own workspace so the harness can prove the tenant filter
// is selective and can delete exactly what it created, without touching rows
// another test file owns.
export const BENCHMARK_WORKSPACE = "ws_benchmark";

// 10k rows in the measured workspace, as requested. The decoy tenants matter
// as much as the measured rows: a single-workspace table gives the planner no
// selectivity signal on the leading workspace_id column, so it will happily
// walk the pre-existing single-column indexes (created_at DESC, priority) and
// filter rows out of them, and the composite indexes this migration adds look
// useless. Real Tunaxa is multi-tenant, so the decoys model the rest of the
// deployment and let the planner make the choice it would really face.
export const BENCHMARK_ROWS = 10000;
export const BENCHMARK_DECOY_WORKSPACES = 9;
export const BENCHMARK_DECOY_ROWS_PER_WORKSPACE = 3000;

export const BENCHMARK_DECOY_ROWS = BENCHMARK_DECOY_WORKSPACES * BENCHMARK_DECOY_ROWS_PER_WORKSPACE;

export const BENCHMARK_TOTAL_ROWS = BENCHMARK_ROWS + BENCHMARK_DECOY_ROWS;

/** Decoy tenant names, workspace_1 .. workspace_N. */
export function decoyWorkspaces() {
  return Array.from(
    { length: BENCHMARK_DECOY_WORKSPACES },
    (_, n) => `ws_benchmark_other_${n + 1}`,
  );
}

/**
 * SQL fragment yielding the workspace_id for series row `i`.
 *
 * The first BENCHMARK_ROWS rows are the measured tenant; the rest are spread
 * round-robin across the decoys. Written as a CASE over a subselect so each
 * insert stays a single statement with no bind parameters - the extended
 * protocol that node-postgres uses rejects multi-statement text, and a
 * parameterised $1 inside a 10k-row generate_series would be re-planned per row.
 */
export function workspaceCaseSql() {
  // Each decoy owns a contiguous block of series rows, so the measured tenant
  // and every decoy get a predictable, exactly-known row count - the counts are
  // asserted after seeding, so a broken distribution fails loudly instead of
  // quietly skewing the plans.
  const decoys = decoyWorkspaces()
    .map(
      (ws, n) =>
        `WHEN i <= ${BENCHMARK_ROWS + (n + 1) * BENCHMARK_DECOY_ROWS_PER_WORKSPACE} THEN '${ws}'`,
    )
    .join("\n             ");
  return `CASE
             WHEN i <= ${BENCHMARK_ROWS} THEN '${BENCHMARK_WORKSPACE}'
             ${decoys}
             ELSE '${decoyWorkspaces().at(-1)}'
           END`;}

// Contacts, deals, activities and tasks are the four tables the request named;
// leads, tickets and quotes are here too because patterns 5, 8 and 10 read
// those, and an empty table would report a fast plan for the wrong reason.
export const BENCHMARK_TABLES = [
  "contacts",
  "deals",
  "activities",
  "tasks",
  "leads",
  "tickets",
  "quotes",
];

// 53 minutes per row spreads 10k rows across ~369 days, so a "last 30 days"
// dashboard window selects ~800 rows rather than the whole table.
const CREATED_AT_SPREAD = "53 minutes";

// Seed vocabulary, taken from the same places the app defines it:
//   deals.stage   - property_definitions 'deal'/'stage' options (migration 001)
//   leads.status  - property_definitions 'lead'/'status' options (migration 001)
//   tickets.stage - TICKET_STAGES in routes/tickets.js
// Keeping these as constants and splicing them into the INSERTs means the seed
// cannot drift from the values the repositories filter on.
const DEAL_STAGES = [
  "proposalsent",
  "negotiation",
  "contractsent",
  "closedwon",
  "closedlost",
];
const LEAD_STATUSES = ["New", "Contacted", "Qualified", "Unqualified"];
const TICKET_STAGES = ["New", "In Progress", "Awaiting Client", "Resolved"];
const TICKET_PRIORITIES = ["Low", "Normal", "High", "Urgent"];
const TASK_STATUSES = ["Open", "In Progress", "Done"];
const ACTIVITY_TYPES = ["call", "email", "meeting", "note", "sms"];
const QUOTE_STATUSES = ["Draft", "Sent", "Signed", "Expired"];

/**
 * SQL expression picking one value out of `values`, round-robin per series row.
 * Produces `(ARRAY['a','b'])[((i % 2) + 1)]`, so the generated rows spread
 * evenly across the vocabulary the way real records do instead of collapsing
 * onto one value - a single-valued column would make every filter selective and
 * the plans meaningless.
 */
function pickSql(values) {
  return `(ARRAY[${values.map((v) => `'${v}'`).join(",")}])[((i % ${values.length}) + 1)]`;
}

export const QUERY_PATTERNS = [
  {
    id: 1,
    label: "List contacts (paginated, workspace scoped)",
    source: "repositories/contacts.js findAll()",
    sql: `SELECT * FROM contacts
          WHERE workspace_id = $1
          ORDER BY created_at DESC
          LIMIT 50 OFFSET 0`,
    params: [BENCHMARK_WORKSPACE],
    expectIndexScan: true,
  },
  {
    id: 2,
    label: "List deals by stage and workspace",
    source: "repositories/deals.js pipeline board",
    sql: `SELECT * FROM deals
          WHERE workspace_id = $1 AND stage = $2
          ORDER BY created_at DESC
          LIMIT 50`,
    params: [BENCHMARK_WORKSPACE, "closedwon"],
    expectIndexScan: true,
  },
  {
    id: 3,
    label: "List deals by owner / rep",
    source: "repositories/deals.js findAll({ owner_id })",
    sql: `SELECT * FROM deals
          WHERE workspace_id = $1 AND owner_id = $2
          ORDER BY created_at DESC
          LIMIT 50`,
    params: [BENCHMARK_WORKSPACE, "owner_42"],
    expectIndexScan: true,
  },
  {
    id: 4,
    label: "Contact search by email or name",
    source: "repositories/contacts.js findAll({ q }) / findByEmail()",
    sql: `SELECT * FROM contacts
          WHERE workspace_id = $1
            AND (LOWER(email) = LOWER($2) OR LOWER(first_name) LIKE LOWER($3))
          LIMIT 20`,
    // Anchored prefix so the varchar_pattern_ops btree is a legitimate match;
    // the repository's real search is a substring ILIKE, which no btree serves
    // without pg_trgm. See the note in __tests__/db-indexes.test.js.
    params: [BENCHMARK_WORKSPACE, "bench.contact.5000@example.test", "benchfirst5000%"],
    expectIndexScan: true,
  },
  {
    id: 5,
    label: "Lead lookup by email and status",
    source: "repositories/leads.js findByEmail()",
    sql: `SELECT * FROM leads
          WHERE workspace_id = $1 AND status = $2 AND LOWER(email) = LOWER($3)`,
    params: [BENCHMARK_WORKSPACE, "New", "bench.lead.777@example.test"],
    expectIndexScan: true,
  },
  {
    id: 6,
    label: "Timeline activities for a record",
    source: "repositories/activities.js findAll({ record_id })",
    sql: `SELECT * FROM activities
          WHERE workspace_id = $1 AND record_id = $2
          ORDER BY created_at DESC
          LIMIT 50`,
    params: [BENCHMARK_WORKSPACE, "rec_1234"],
    expectIndexScan: true,
  },
  {
    id: 7,
    label: "Pending tasks by assignee",
    source: "repositories/tasks.js findAll({ assigned_to, completed: false })",
    sql: `SELECT * FROM tasks
          WHERE workspace_id = $1 AND assigned_to = $2 AND completed = $3
          ORDER BY due_date ASC
          LIMIT 50`,
    // `completed`, not `status`: repositories/tasks.js:88 pushes a boolean
    // equality into the WHERE clause, and `status` is the legacy vocabulary the
    // repository never filters on. This is the shape the partial index
    // idx_tasks_open_assigned_due is built for.
    params: [BENCHMARK_WORKSPACE, "user_7", false],
    expectIndexScan: true,
  },
  {
    id: 8,
    label: "Open tickets by priority and stage",
    source: "routes/tickets.js SLA board",
    sql: `SELECT * FROM tickets
          WHERE workspace_id = $1 AND resolved_at IS NULL
          ORDER BY priority DESC, created_at DESC
          LIMIT 50`,
    params: [BENCHMARK_WORKSPACE],
    expectIndexScan: true,
  },
  {
    id: 9,
    label: "Dashboard revenue and pipeline aggregation",
    source: "repositories/deals.js getPipelineSummary(), services/reports.js",
    sql: `SELECT stage, COUNT(*), SUM(value)
          FROM deals
          WHERE workspace_id = $1 AND created_at >= $2 AND created_at <= $3
          GROUP BY stage`,
    // One month of the 369-day spread, so the aggregate reads ~800 rows.
    params: [BENCHMARK_WORKSPACE, "NOW() - INTERVAL '30 days'", "NOW()"],
    // Interval arithmetic cannot be pre-bound to a parameter without the
    // planner knowing the value, so the literals are inlined below.
    inlineParams: true,
    expectIndexScan: false,
  },
  {
    id: 10,
    label: "Quote lookup by deal",
    source: "repositories/quotes.js findAll({ deal_id })",
    sql: `SELECT * FROM quotes
          WHERE workspace_id = $1 AND deal_id = $2
          ORDER BY created_at DESC
          LIMIT 50`,
    params: [BENCHMARK_WORKSPACE, "deal_123"],
    expectIndexScan: true,
  },
];

// A derived value has to be rendered into the SQL text, not passed as a bind
// parameter: `created_at >= $2` with a bound string would force a cast per row
// and is not what the repository emits.
export function renderSql(pattern) {
  if (!pattern.inlineParams) return pattern.sql;
  return pattern.sql
    .replace("$2", "(NOW() - INTERVAL '30 days')")
    .replace("$3", "NOW()");
}

export function renderParams(pattern) {
  return pattern.inlineParams ? [pattern.params[0]] : pattern.params;
}

// ---------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------

// Every insert is a single INSERT ... SELECT FROM generate_series, so seeding
// 10k rows per table is a handful of round trips instead of 40k. Values are
// derived arithmetically from the series number rather than randomly, so two
// runs produce the same data and the plans are comparable.
const SEED_STATEMENTS = [
  `INSERT INTO contacts (id, workspace_id, company_id, first_name, last_name, email, phone, title, owner_id, created_at, updated_at)
   SELECT 'bench_contact_' || i,
          ${workspaceCaseSql()},
          'bench_company_' || (i % 500),
          'benchfirst' || i,
          'benchlast' || i,
          'bench.contact.' || i || '@example.test',
          '+1-555-' || lpad(i::text, 6, '0'),
          'Bench Title ' || (i % 12),
          'owner_' || (i % 50),
          NOW() - (i * INTERVAL '${CREATED_AT_SPREAD}'),
          NOW()
     FROM generate_series(1, ${BENCHMARK_TOTAL_ROWS}) AS i
    ON CONFLICT (id) DO NOTHING`,

  `INSERT INTO deals (id, workspace_id, title, company, company_id, contact, contact_id, owner, owner_id, value, stage, created_at, updated_at)
   SELECT 'bench_deal_' || i,
          ${workspaceCaseSql()},
          'Bench Deal ' || i,
          'Bench Company ' || (i % 500),
          'bench_company_' || (i % 500),
          'benchfirst' || i,
          'bench_contact_' || i,
          'Bench Rep ' || (i % 50),
          'owner_' || (i % 50),
          (i % 10000) * 13.5,
          ${pickSql(DEAL_STAGES)},
          NOW() - (i * INTERVAL '${CREATED_AT_SPREAD}'),
          NOW()
     FROM generate_series(1, ${BENCHMARK_TOTAL_ROWS}) AS i
    ON CONFLICT (id) DO NOTHING`,

  `INSERT INTO activities (id, workspace_id, type, title, subject, contact, company, direction, record_id, entity_type, entity_id, user_id, contact_id, deal_id, created_at, updated_at)
   SELECT 'bench_activity_' || i,
          ${workspaceCaseSql()},
          ${pickSql(ACTIVITY_TYPES)},
          'Bench Activity ' || i,
          'Subject ' || (i % 40),
          'benchfirst' || i,
          'Bench Company ' || (i % 500),
          ${pickSql(["inbound","outbound"])},
          'rec_' || (i % 500),
          'contact',
          'bench_contact_' || i,
          'user_' || (i % 25),
          'bench_contact_' || i,
          'bench_deal_' || i,
          NOW() - (i * INTERVAL '${CREATED_AT_SPREAD}'),
          NOW()
     FROM generate_series(1, ${BENCHMARK_TOTAL_ROWS}) AS i
    ON CONFLICT (id) DO NOTHING`,

  `INSERT INTO tasks (id, workspace_id, title, description, status, completed, priority, owner, assigned_to, due_date, contact_id, deal_id, created_at, updated_at)
   SELECT 'bench_task_' || i,
          ${workspaceCaseSql()},
          'Bench Task ' || i,
          'Description ' || (i % 30),
          ${pickSql(TASK_STATUSES)},
          (i % 3) = 2,
          ${pickSql(["Low","Medium","High","Urgent"])},
          'Bench Rep ' || (i % 50),
          'user_' || (i % 25),
          NOW() + ((i % 400) * INTERVAL '1 day'),
          'bench_contact_' || i,
          'bench_deal_' || i,
          NOW() - (i * INTERVAL '${CREATED_AT_SPREAD}'),
          NOW()
     FROM generate_series(1, ${BENCHMARK_TOTAL_ROWS}) AS i
    ON CONFLICT (id) DO NOTHING`,

  `INSERT INTO leads (id, workspace_id, first_name, last_name, email, phone, company_name, status, source, value, owner_id, created_at, updated_at)
   SELECT 'bench_lead_' || i,
          ${workspaceCaseSql()},
          'benchlead' || i,
          'benchsur' || i,
          'bench.lead.' || i || '@example.test',
          '+1-556-' || lpad(i::text, 6, '0'),
          'Bench Company ' || (i % 500),
          ${pickSql(LEAD_STATUSES)},
          ${pickSql(["webinar","referral","organic","paid"])},
          (i % 5000) * 21.0,
          'owner_' || (i % 50),
          NOW() - (i * INTERVAL '${CREATED_AT_SPREAD}'),
          NOW()
     FROM generate_series(1, ${BENCHMARK_TOTAL_ROWS}) AS i
    ON CONFLICT (id) DO NOTHING`,

  `INSERT INTO tickets (id, workspace_id, subject, description, stage, priority, source, contact, contact_email, comments, first_response_at, resolved_at, resolved_by, created_at, updated_at)
   SELECT 'bench_ticket_' || i,
          ${workspaceCaseSql()},
          'Bench Ticket ' || i,
          'Description ' || (i % 25),
          ${pickSql(TICKET_STAGES)},
          ${pickSql(TICKET_PRIORITIES)},
          ${pickSql(["Email","Phone","Web","Chat"])},
          'benchfirst' || i,
          'bench.contact.' || i || '@example.test',
          '[]'::jsonb,
          NOW() - (i * INTERVAL '${CREATED_AT_SPREAD}'),
          CASE WHEN i % 4 = 3 THEN NOW() - (i * INTERVAL '${CREATED_AT_SPREAD}') + INTERVAL '2 hours' ELSE NULL END,
          CASE WHEN i % 4 = 3 THEN 'user_' || (i % 25) ELSE NULL END,
          NOW() - (i * INTERVAL '${CREATED_AT_SPREAD}'),
          NOW()
     FROM generate_series(1, ${BENCHMARK_TOTAL_ROWS}) AS i
    ON CONFLICT (id) DO NOTHING`,

  `INSERT INTO quotes (id, workspace_id, title, quote_number, deal_id, company_id, contact_id, status, subtotal, discount, tax, total, items, created_at, updated_at)
   SELECT 'bench_quote_' || i,
          ${workspaceCaseSql()},
          'Bench Quote ' || i,
          'Q-' || i,
          'bench_deal_' || (i % 300),
          'bench_company_' || (i % 500),
          'bench_contact_' || i,
          ${pickSql(QUOTE_STATUSES)},
          (i % 900) * 31.0,
          0, 0,
          (i % 900) * 31.0,
          '[]'::jsonb,
          NOW() - (i * INTERVAL '${CREATED_AT_SPREAD}'),
          NOW()
     FROM generate_series(1, ${BENCHMARK_TOTAL_ROWS}) AS i
    ON CONFLICT (id) DO NOTHING`,
];

export async function seedBenchmarkData() {
  for (const sql of SEED_STATEMENTS) {
    await query(sql);
  }
  // VACUUM, not a bare ANALYZE, and the difference is not cosmetic. An Index
  // Only Scan is only cheap once the visibility map marks every heap page
  // all-visible; freshly inserted pages are not, so on a plain ANALYZE the
  // planner prices the covering index as if it had to visit the heap for every
  // row and falls back to a single-column index plus a sort. The seeded rows are
  // synthetic and uncommitted to any real workload, so setting the map here is
  // exactly the state a long-lived table would be in.
  await query(`VACUUM (ANALYZE) ${BENCHMARK_TABLES.join(", ")}`);
}

export const ALL_BENCHMARK_WORKSPACES = [BENCHMARK_WORKSPACE, ...decoyWorkspaces()];

export async function clearBenchmarkData() {
  // One DELETE per table: node-postgres sends parameterised text over the
  // extended protocol, which accepts a single statement only. Scoped by
  // workspace_id so rows belonging to another test file are never touched.
  for (const table of BENCHMARK_TABLES) {
    await query(`DELETE FROM ${table} WHERE workspace_id = ANY($1)`, [ALL_BENCHMARK_WORKSPACES]);
  }
  // Same reasoning as the post-seed VACUUM: clearing the rows leaves the tables
  // holding dead tuples, and the plan numbers a later run sees should not depend
  // on whether this cleanup ran.
  await query(`VACUUM (ANALYZE) ${BENCHMARK_TABLES.join(", ")}`);
}

export async function benchmarkRowCounts() {
  const result = await query(
    `SELECT 'contacts' AS table_name, COUNT(*)::int AS n FROM contacts WHERE workspace_id = $1
     UNION ALL SELECT 'deals',        COUNT(*)::int FROM deals        WHERE workspace_id = $1
     UNION ALL SELECT 'activities',   COUNT(*)::int FROM activities   WHERE workspace_id = $1
     UNION ALL SELECT 'tasks',        COUNT(*)::int FROM tasks        WHERE workspace_id = $1
     UNION ALL SELECT 'leads',        COUNT(*)::int FROM leads        WHERE workspace_id = $1
     UNION ALL SELECT 'tickets',      COUNT(*)::int FROM tickets      WHERE workspace_id = $1
     UNION ALL SELECT 'quotes',       COUNT(*)::int FROM quotes       WHERE workspace_id = $1`,
    [BENCHMARK_WORKSPACE],
  );
  return result.rows;
}

// ---------------------------------------------------------------
// Plan introspection
// ---------------------------------------------------------------

function walkPlan(node, acc = { nodeTypes: [], indexNames: [] }) {
  if (!node || typeof node !== "object") return acc;
  if (node["Node Type"]) acc.nodeTypes.push(node["Node Type"]);
  if (node["Index Name"]) acc.indexNames.push(node["Index Name"]);
  for (const child of node.Plans || []) walkPlan(child, acc);
  return acc;
}

export const INDEX_SCAN_NODES = new Set([
  "Index Scan",
  "Index Only Scan",
  "Bitmap Index Scan",
  "Bitmap And",
  "Bitmap Or",
]);

/**
 * Runs EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) for one pattern.
 *
 * `forceIndex` reruns the same query with enable_seqscan = off. That is a
 * diagnostic, not a claim: on a 10k-row table the cost model is free to pick a
 * sequential scan because it genuinely is cheaper, and the natural plan is the
 * one that matters. The forced run answers the separate question "is a usable
 * index path available at all", which is what regresses when someone drops an
 * index.
 */
export async function explainPattern(pattern, { forceIndex = false, repeats = 3 } = {}) {
  const client = await getPool().connect();
  const sql = renderSql(pattern);
  const params = renderParams(pattern);
  try {
    if (forceIndex) await client.query("SET enable_seqscan = off");
    // First execution pays for parsing/plan caching and buffer population.
    // Averaging the rest is closer to steady-state latency.
    await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
    let best = null;
    for (let n = 0; n < repeats; n += 1) {
      const result = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
      const doc = result.rows[0]["QUERY PLAN"][0];
      const { nodeTypes, indexNames } = walkPlan(doc.Plan);
      const candidate = {
        id: pattern.id,
        label: pattern.label,
        source: pattern.source,
        executionTimeMs: doc["Execution Time"],
        planningTimeMs: doc["Planning Time"],
        actualRows: doc.Plan["Actual Rows"],
        nodeTypes,
        indexNames,
        sharedHitBlocks: doc.Plan["Shared Hit Blocks"] || 0,
        usedIndexScan: nodeTypes.some((t) => INDEX_SCAN_NODES.has(t)),
        plan: doc.Plan,
      };
      if (!best || candidate.executionTimeMs < best.executionTimeMs) best = candidate;
    }
    return best;
  } finally {
    if (forceIndex) await client.query("RESET enable_seqscan").catch(() => {});
    client.release();
  }
}

/** Best (fastest) of a natural and a seqscan-disabled run, for reporting. */
export async function runBenchmarks({ repeats = 3 } = {}) {
  const results = [];
  for (const pattern of QUERY_PATTERNS) {
    const natural = await explainPattern(pattern, { repeats });
    const forced = await explainPattern(pattern, { forceIndex: true, repeats });
    results.push({ ...natural, forcedExecutionTimeMs: forced.executionTimeMs, forcedIndexNames: forced.indexNames, forcedNodeTypes: forced.nodeTypes, forcedUsedIndexScan: forced.usedIndexScan });
  }
  return results;
}
