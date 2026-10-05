import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    hookTimeout: 30000,
    testTimeout: 30000,
    // Every test file shares one backend/__tests__/test-db.json (via
    // resetTestDb) and, once migrated, one Postgres instance. Running files
    // concurrently lets one file's reset wipe rows another file is asserting
    // on, so the suite has to be serial.
    fileParallelism: false,
    env: {
      VITEST: 'true',
    },
    server: {
      deps: {
        external: [/bullmq/, /ioredis/],
      },
    },
  },
});
