# Tunaxa CRM

Tunaxa CRM is a full-stack customer relationship and workflow platform built as a monorepo with a Node.js/Express backend and a React + Vite frontend.

The project is designed for operations teams that need CRM tracking, workflow automation, lead management, reporting, forms, and webhook integrations in one application.

## Project overview

This repository contains:

- A backend API in `backend/` built with Express and PostgreSQL
- A frontend app in `web/` built with React, Vite, and React Router
- An orchestration launcher at `start.js` for starting both services together
- Windows startup helper `start.bat`

## Tech stack

- Frontend: React 18, Vite, React Router, i18next
- Backend: Node.js, Express 5
- Database: PostgreSQL via `pg`
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
├─ README.md
└─ .gitignore
```

## Requirements

Before running the project, install:

- Node.js 18 or newer
- PostgreSQL running locally or on a reachable host
- Optional: Redis if you want queue and cache support enabled

## Environment and configuration

The backend uses PostgreSQL connection settings from environment variables, with defaults defined in `backend/db/pg.js`:

- Host: `127.0.0.1`
- Port: `5432`
- Database: `tunaxa`
- User: `postgres`
- Password: `tunaxa2024`

If you want to override these values, define environment variables such as:

```bash
export PGHOST=127.0.0.1
export PGPORT=5432
export PGDATABASE=tunaxa
export PGUSER=postgres
export PGPASSWORD=tunaxa2024
```

For Redis-backed services, set:

```bash
export REDIS_URL=redis://127.0.0.1:6380
```

If Redis is not configured, the app will still start in a reduced mode instead of failing outright.

## Installation

From the repository root:

```bash
npm install
```

## Running the app

### Start everything together

```bash
npm start
```

This launches:

- the backend on `http://127.0.0.1:3001`
- the frontend on `http://127.0.0.1:5173` by default

### Run backend only

```bash
npm run server
```

### Run frontend only

```bash
npm run dev
```

### Production build

```bash
npm run build
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
- PostgreSQL is the core data layer for the app.
- Redis is optional but required for webhook queueing and cache features.

## Development workflow

Typical local workflow:

1. Start PostgreSQL and ensure the `tunaxa` database exists.
2. Install dependencies with `npm install`.
3. Run `npm start` to bring up API + frontend together.
4. Open the frontend URL in the browser.
5. Run tests with `npm test` during development.

## License

This project does not currently declare a license in the repository metadata.

## Support

For project-specific configuration or production deployment issues, review the runtime scripts and environment variables above before changing the app structure.
