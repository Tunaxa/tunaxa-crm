# Tunaxa CRM

Tunaxa CRM is a full-stack customer relationship and workflow platform built as a monorepo with a Node.js/Express backend and a React + Vite frontend.

The project is designed for operations teams that need CRM tracking, workflow automation, lead management, reporting, forms, and webhook integrations in one application.

## Project overview

This repository contains:

- A backend API in `backend/` built with Express
- A frontend app in `web/` built with React, Vite, and React Router
- An orchestration launcher at `start.js` for starting both services together
- Windows startup helper `start.bat`

## Tech stack

- Frontend: React 18, Vite, React Router, i18next
- Backend: Node.js, Express 5
- Storage: JSON store at `backend/data/db.json`, plus PostgreSQL via `pg` for the V1 object API, reporting, and the migration runner
- Background jobs: BullMQ and Redis (optional for queue/cache features)
- Auth and permissions: custom session + RBAC middleware
- Monitoring: Sentry
- Testing: Vitest + Supertest

## Main features

- Contact, lead, company, deal, task, and activity management
- Dashboard and reporting views
- Pipeline and workflow execution engine
- Teams, permissions, and access control
- Form and landing page management
- Email campaigns, surveys, and marketing modules
- Webhooks and webhook endpoint handling
- Audit logs and revision tracking
- File uploads and media handling
- GraphQL endpoints
- Custom resources and v1 compatibility routes

## Repository structure

```text
.
├─ backend/
│  ├─ db/
│  ├─ middleware/
│  ├─ routes/
│  ├─ services/
│  ├─ workers/
│  ├─ uploads/
│  ├─ data/
│  ├─ __tests__/
│  └─ server.js
├─ web/
│  ├─ src/
│  ├─ public/
│  ├─ index.html
│  ├─ vite.config.ts
│  └─ tsconfig.json
├─ package.json
├─ start.js
├─ start.bat
├─ .env.example
├─ README.md
└─ .gitignore
```

## Requirements

Before running the project, install:

- Node.js 20.12 or newer — the runtime reads `.env` via `process.loadEnvFile()` and uses it with no extra flags. Node 22 LTS is recommended.
- PostgreSQL running locally or on a reachable host — required by `npm run migrate`, `npm run migrate:data`, and the V1 object API. Not required to boot the CRM.
- Optional: Redis, if you want the BullMQ webhook queue and query cache enabled.

## Environment and configuration

Every setting has a default, so the app boots with no `.env` at all. To customise anything, copy the template and edit it:

```bash
cp .env.example .env
```

Precedence is **real environment variable → `.env` → built-in default**. A shell export or CI secret always overrides the file, and `.env` never overrides the environment.

### Where the defaults live

The single source of truth is `backend/runtime.js`. `backend/db/pg.js` reads its connection defaults from there, and `web/vite.config.ts` derives its proxy target from the same module, so the port and database settings cannot drift between the API, the dev proxy, and this document.

### Ports

| Service | Default | Override |
| --- | --- | --- |
| Backend API | `3001` | `PORT` |
| Backend interface | `127.0.0.1` | `HOST` (use `0.0.0.0` in a container) |
| Frontend dev server | `5173` | fixed by the `dev` / `start` scripts |

`PORT` is honoured by the API **and** by the Vite dev proxy, so changing it once keeps both in sync. The frontend talks to the API through a same-origin `/api` proxy — there is no API origin to configure in the frontend.

### PostgreSQL

The backend reads the standard libpq `PG*` variables. `DATABASE_URL` and `DB_*` are **not** supported — there is no second naming convention to keep in sync.

| Variable | Default |
| --- | --- |
| `PGHOST` | `127.0.0.1` |
| `PGPORT` | `5432` |
| `PGDATABASE` | `tunaxa` |
| `PGUSER` | `postgres` |
| `PGPASSWORD` | `tunaxa2024` |

Set `PGPASSWORD` to the password of your own local `postgres` role — the default only matches a stock install that uses the project's password.

### Other variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `BASE_URL` | Absolute origin third parties use to reach the API (webhook target URLs, email tracking pixels). Set this behind a reverse proxy. | `http://$HOST:$PORT` |
| `API_HEALTH_URL` | Health probe used by the `start.js` launcher. | derived from `BASE_URL` |
| `REDIS_URL` / `REDIS_ENABLED` | Redis connection and toggle. | unset |
| `NODE_ENV` | `production` marks the auth cookie `Secure` and switches the Sentry environment. | `development` |
| `SENTRY_DSN` | Sentry DSN. Errors are not reported when unset. | unset |

If Redis is not configured, the app starts in a reduced mode instead of failing outright: no BullMQ webhook queue and no query cache, everything else works normally.

## Installation

From the repository root:

```bash
npm install
cp .env.example .env   # optional, but needed for PostgreSQL access
```

## Running the app

### Database migrations

PostgreSQL schema migrations are applied in filename order and recorded in a `schema_migrations` table, so this is safe to re-run:

```bash
npm run migrate
```

Create the database once before the first run:

```bash
createdb tunaxa
```

This step is only required for the V1 object API, reporting, and `npm run migrate:data`. The CRM's own workspace records live in `backend/data/db.json` and need no migration.

To populate the JSON store with sample data (idempotent — re-running skips records that already exist):

```bash
npm run seed
```

This creates an `admin@tunaxa.com` / `tunaxa2024` login.

### Start everything together

```bash
npm start
```

This launches:

- the backend on `http://127.0.0.1:3001` (or `PORT`)
- the frontend on `http://127.0.0.1:5173`, which proxies `/api` and `/uploads` to the backend

Both processes load the repository `.env`.

### Run backend only

```bash
npm run server
```

This loads `.env` as well.

### Run frontend only

```bash
npm run dev
```

Start the backend separately first, otherwise API calls will fail.

### Production build

```bash
npm run build
npm run preview
```

### Run tests

```bash
npm test
```

## Default app behavior

The launcher script at `start.js` checks whether the backend is up, starts it if needed, and then launches the Vite frontend from the `web/` directory.

If port `5173` is occupied, Vite will automatically choose the next available port.

## Important notes

- The repo is configured as a root-level project using `start.js`.
- The frontend is in `web/` and should not be treated as the root project entry point.
- The backend exposes REST and GraphQL-style CRM endpoints and also handles automation features.
- Workspace records are stored in the JSON store at `backend/data/db.json`. PostgreSQL backs the V1 object API, reporting, and the migration runner.
- Redis is optional but required for webhook queueing and cache features.
- `.env` is git-ignored. `.env.example` is the checked-in template and contains no secrets.

## Development workflow

Typical local workflow, in order:

1. Install dependencies: `npm install`.
2. Copy the environment template and set `PGPASSWORD` to your local `postgres` password: `cp .env.example .env`.
3. Start PostgreSQL and ensure the `tunaxa` database exists: `createdb tunaxa`.
4. Apply the schema: `npm run migrate`.
5. Optionally load sample data: `npm run seed`.
6. Bring up API + frontend together: `npm start`.
7. Open `http://127.0.0.1:5173` in the browser. The first visit prompts you to create the workspace owner.
8. Run `npm test` during development.

Steps 3 and 4 can be skipped if you are only working on the JSON-store CRM features; steps 1, 2, 6, and 7 are the minimum for a working app.

## License

This project does not currently declare a license in the repository metadata.

## Support

For project-specific configuration or production deployment issues, review `backend/runtime.js`, the variables listed above, and the runtime scripts before changing the app structure.
