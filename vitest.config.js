import { defineConfig } from "vitest/config";

/**
 * Central Vitest configuration for the backend suite.
 *
 * fileParallelism: false runs test files strictly sequentially, so workers
 * never execute concurrently. Combined with the per-worker database-path
 * isolation in backend/__tests__/setup.js (unique test-db-<VITEST_POOL_ID>.json
 * per worker) and the TEST_DB_PATH override in backend/store.js, each test file
 * owns a distinct JSON-store handle. This eliminates the Windows EPERM
 * rename/file-locking races that occurred when parallel workers read and wrote
 * the same local database file.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});