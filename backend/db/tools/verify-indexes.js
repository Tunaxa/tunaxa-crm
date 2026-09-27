// Standalone index benchmark for migration 012.
//
//   node backend/db/tools/verify-indexes.js
//
// Seeds a 10k-row workspace, runs EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
// against the ten mission-critical query patterns, prints a plan/latency
// table, and deletes everything it created - including on failure, so a
// crashed run cannot leave synthetic rows behind for the test suite to trip
// over.
//
// The same patterns and the same assertions run under vitest in
// backend/__tests__/db-indexes.test.js. This script exists so the numbers can
// be reproduced and eyeballed without a test runner; the test exists so a
// regression fails CI. Both import index-benchmarks.js so they cannot drift.

import {
  BENCHMARK_DECOY_ROWS,
  BENCHMARK_ROWS,
  BENCHMARK_WORKSPACE,
  QUERY_PATTERNS,
  benchmarkRowCounts,
  clearBenchmarkData,
  runBenchmarks,
  seedBenchmarkData,
} from "./index-benchmarks.js";
import { closePool } from "../pg.js";

const LATENCY_TARGET_MS = 10.0;

function pad(value, width) {
  return String(value).padEnd(width);
}

function padStart(value, width) {
  return String(value).padStart(width);
}

async function main() {
  console.log(`Seeding ${BENCHMARK_ROWS} rows (+${BENCHMARK_DECOY_ROWS} decoy) in ${BENCHMARK_WORKSPACE}...`);
  await clearBenchmarkData();
  await seedBenchmarkData();

  const counts = await benchmarkRowCounts();
  console.log("\nRow counts in the measured workspace:");
  for (const row of counts) console.log(`  ${pad(row.table_name, 14)}${row.n}`);

  console.log(`\nEXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) on ${QUERY_PATTERNS.length} patterns\n`);
  const header =
    `${pad("#", 3)}${pad("pattern", 42)}${padStart("time(ms)", 10)}  ${pad("plan node", 22)}  index`;
  console.log(header);
  console.log("-".repeat(header.length + 12));

  const results = await runBenchmarks();
  let failures = 0;

  for (const r of results) {
    const node = r.nodeTypes.find((t) => t.includes("Index")) || r.nodeTypes[0];
    const index = r.indexNames.join(",") || "(sequential scan)";
    const slow = r.executionTimeMs >= LATENCY_TARGET_MS;
    if (slow) failures += 1;
    console.log(
      `${pad(r.id, 3)}${pad(r.label, 42)}${padStart(r.executionTimeMs.toFixed(3), 10)}  ${pad(node, 22)}  ${index}${slow ? "   <-- OVER TARGET" : ""}`,
    );
  }

  console.log("\nIndex-availability check (same queries, enable_seqscan = off):");
  for (const r of results) {
    const status = r.forcedUsedIndexScan ? "index path available" : "NO INDEX PATH";
    if (!r.forcedUsedIndexScan) failures += 1;
    console.log(
      `  ${pad(r.id, 3)}${padStart(r.forcedExecutionTimeMs.toFixed(3), 10)} ms  ${pad(status, 22)}  ${r.forcedIndexNames.join(",") || "-"}`,
    );
  }

  await clearBenchmarkData();
  const after = await benchmarkRowCounts();
  const leftovers = after.reduce((sum, r) => sum + r.n, 0);
  console.log(`\nCleanup: ${leftovers === 0 ? "all benchmark rows removed" : `${leftovers} ROWS LEFT BEHIND`}`);
  if (leftovers !== 0) failures += 1;

  console.log(
    `\n${failures === 0 ? "PASS" : `FAIL (${failures} problem(s))`}: ${results.length} patterns, target < ${LATENCY_TARGET_MS} ms`,
  );
  return failures === 0 ? 0 : 1;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  console.error(`\nverify-indexes failed: ${error.message}`);
  console.error(error.stack);
  try {
    await clearBenchmarkData();
    console.log("Benchmark rows cleaned up after failure.");
  } catch (cleanupError) {
    console.error(`Cleanup also failed: ${cleanupError.message}`);
  }
  exitCode = 1;
} finally {
  await closePool();
}

process.exit(exitCode);
