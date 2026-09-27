import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, it, expect } from 'vitest';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const workflowPath = path.join(root, '.github', 'workflows', 'ci.yml');
const pkgPath = path.join(root, 'package.json');

const workflowText = fs.readFileSync(workflowPath, 'utf8');
const workflow = load(workflowText);
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

/**
 * `on` is parsed by js-yaml as the boolean `true` under YAML 1.1 rules in some
 * resolvers. GitHub's own parser treats it as the string key `on`. Accept either
 * so this suite does not depend on the resolver's truthiness quirk.
 */
const triggers = workflow.on ?? workflow[true];

const job = workflow.jobs?.ci;
const steps = job?.steps ?? [];
const services = job?.services ?? {};

/** Step lookups are by the command they run, which is what the gates care about. */
const stepFor = (fragment) => steps.find((step) => typeof step.run === 'string' && step.run.includes(fragment));

describe('GitHub Actions CI workflow', () => {
  it('is a parseable YAML mapping with a name', () => {
    expect(typeof workflowText).toBe('string');
    expect(workflowText.length).toBeGreaterThan(0);
    expect(load(workflowText)).toBeTypeOf('object');
    expect(workflow.name).toBe('CI Pipeline');
  });

  it('triggers on pull requests targeting main', () => {
    expect(triggers).toBeTruthy();
    expect(triggers.pull_request).toBeTruthy();
    expect(triggers.pull_request.branches).toContain('main');
  });

  it('also runs on pushes to main and supports manual dispatch', () => {
    expect(triggers.push?.branches).toContain('main');
    // `workflow_dispatch:` with no value parses as null, so assert on key
    // presence rather than truthiness.
    expect(Object.keys(triggers)).toContain('workflow_dispatch');
  });

  it('cancels superseded runs but never on main', () => {
    expect(workflow.concurrency).toBeTruthy();
    expect(workflow.concurrency.group).toContain('github.workflow');
    expect(workflow.concurrency.group).toContain('github.ref');
    expect(workflow.concurrency['cancel-in-progress']).toContain("github.ref != 'refs/heads/main'");
  });

  it('defines all jobs locally with no cross-repo reusable workflow', () => {
    // The previous ci.yml delegated a job to Tunaxa/.github@main. That
    // delegation was removed deliberately; guard against it creeping back,
    // because a reusable-workflow job cannot declare services or env.
    const jobs = Object.values(workflow.jobs ?? {});
    expect(jobs.length).toBeGreaterThan(0);
    for (const entry of jobs) {
      expect(entry.uses).toBeUndefined();
    }
  });

  it('runs the single job on ubuntu-latest', () => {
    expect(job).toBeTruthy();
    expect(job['runs-on']).toBe('ubuntu-latest');
  });

  describe('postgres service', () => {
    it('uses postgres:16-alpine with the expected credentials', () => {
      expect(services.postgres).toBeTruthy();
      expect(services.postgres.image).toBe('postgres:16-alpine');
      expect(services.postgres.env.POSTGRES_USER).toBeTruthy();
      expect(services.postgres.env.POSTGRES_PASSWORD).toBeTruthy();
      expect(services.postgres.env.POSTGRES_DB).toBe('tunaxa');
    });

    it('publishes 5432 and waits on a health check', () => {
      expect(services.postgres.ports).toContain('5432:5432');
      const options = services.postgres.options ?? '';
      expect(options).toContain('pg_isready');
      expect(options).toContain('--health-interval 10s');
      expect(options).toContain('--health-timeout 5s');
      expect(options).toContain('--health-retries 5');
    });
  });

  describe('redis service', () => {
    it('uses redis:7-alpine and publishes 6379', () => {
      expect(services.redis).toBeTruthy();
      expect(services.redis.image).toBe('redis:7-alpine');
      expect(services.redis.ports).toContain('6379:6379');
    });

    it('waits on a ping health check', () => {
      const options = services.redis.options ?? '';
      expect(options).toContain('redis-cli ping');
      expect(options).toContain('--health-interval 10s');
      expect(options).toContain('--health-timeout 5s');
      expect(options).toContain('--health-retries 5');
    });
  });

  describe('steps', () => {
    it('checks out the repository with actions/checkout@v4', () => {
      const checkout = steps.find((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout'));
      expect(checkout).toBeTruthy();
      expect(checkout.uses).toBe('actions/checkout@v4');
    });

    it('provisions Node with npm caching enabled', () => {
      const setup = steps.find((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/setup-node'));
      expect(setup).toBeTruthy();
      expect(setup.uses).toBe('actions/setup-node@v4');
      expect(String(setup.with['node-version'])).toMatch(/^(20|22)$/);
      expect(setup.with.cache).toBe('npm');
    });

    it('installs dependencies with npm ci', () => {
      const install = steps.find((step) => step.run === 'npm ci');
      expect(install).toBeTruthy();
    });

    it('runs typecheck, lint, migrate and the test suite', () => {
      expect(stepFor('npm run typecheck')).toBeTruthy();
      expect(stepFor('npm run lint')).toBeTruthy();
      expect(stepFor('npm run migrate')).toBeTruthy();
      expect(stepFor('npm test')).toBeTruthy();
    });
  });

  describe('service credentials reach the steps', () => {
    it('exposes matching PG and Redis settings to the job', () => {
      const env = job.env ?? {};
      // Asserted against the service definition rather than a literal, so the
      // password is never duplicated into this test and the two halves cannot
      // drift apart unnoticed.
      expect(env.PGHOST).toBe('localhost');
      expect(String(env.PGPORT)).toBe('5432');
      expect(env.PGUSER).toBe(services.postgres.env.POSTGRES_USER);
      expect(env.PGPASSWORD).toBe(services.postgres.env.POSTGRES_PASSWORD);
      expect(env.PGDATABASE).toBe(services.postgres.env.POSTGRES_DB);
      expect(env.REDIS_URL).toBe('redis://localhost:6379');
      expect(env.REDIS_ENABLED).toBeTruthy();
    });
  });

  /**
   * These assertions encode the current, deliberate gate policy. The repo still
   * carries pre-existing lint errors and pre-existing test failures, so lint and
   * the suite run as advisory steps (`continue-on-error`) while typecheck and
   * migrations stay blocking. Deleting the two `continue-on-error: true` lines
   * is how the debt is retired, and these tests are what makes that flip
   * deliberate instead of accidental.
   */
  describe('gate policy', () => {
    it('blocks merges on typecheck and migrations', () => {
      expect(stepFor('npm run typecheck')['continue-on-error']).toBeFalsy();
      expect(stepFor('npm run migrate')['continue-on-error']).toBeFalsy();
    });

    it('runs lint and the test suite as advisory steps', () => {
      expect(stepFor('npm run lint')['continue-on-error']).toBe(true);
      expect(stepFor('npm test')['continue-on-error']).toBe(true);
    });
  });
});

describe('package.json CI scripts', () => {
  const required = ['typecheck', 'lint', 'migrate', 'test'];

  it.each(required)('defines a non-empty "%s" script', (name) => {
    expect(pkg.scripts).toBeTruthy();
    expect(pkg.scripts[name]).toBeTypeOf('string');
    expect(pkg.scripts[name].trim().length).toBeGreaterThan(0);
  });

  it('typechecks without emitting build output', () => {
    expect(pkg.scripts.typecheck).toContain('tsc');
    expect(pkg.scripts.typecheck).toContain('--noEmit');
  });

  it('lints with ESLint', () => {
    expect(pkg.scripts.lint).toContain('eslint');
  });

  it('migrates through the idempotent runner', () => {
    expect(pkg.scripts.migrate).toContain('run-migrations.js');
  });

  it('runs vitest in single-run mode so CI never enters watch mode', () => {
    expect(pkg.scripts.test).toMatch(/\bvitest\s+run\b/);
    expect(pkg.scripts.test).not.toMatch(/\bvitest\s*$/);
  });
});
