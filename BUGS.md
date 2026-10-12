# Known Issues

- `npm test` is currently configured to run `jest`, but Jest is not installed in `package.json`; the command exits before running tests.
- Running the full Vitest backend directory in parallel can race on the shared Windows `backend/__tests__/test-db.json` file and produce `EPERM` or `ENOENT` rename errors. The focused CRUD suite passes when run with one worker.
- `npm run lint` currently parses TypeScript and TSX files as plain JavaScript and reports parser errors across the existing frontend. The production build succeeds.