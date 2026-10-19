import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { resetTestDb, cleanupTestDb } from './setup.js';
import { mutateDb } from '../store.js';
import { hashPassword } from '../helpers.js';
import {
  ROLES,
  MODULES,
  normalizeRole,
  getNavigationForUser,
} from '../services/navigation.js';

// Data-driven module navigation (P2-BE1-01). These tests pin the wire contract
// of `GET /api/modules` and the role -> visibility matrix behind it. The service
// is pure, so the matrix is asserted both through the HTTP adapter and directly.

const ALL_IDS = [
  'dashboard',
  'contacts',
  'companies',
  'deals',
  'leads',
  'reports',
  'import_export',
  'team',
  'settings',
];
const MEMBER_IDS = [
  'dashboard',
  'contacts',
  'companies',
  'deals',
  'leads',
  'reports',
  'import_export',
];
const VIEWER_IDS = ['dashboard', 'contacts', 'companies', 'deals', 'reports'];
const CONTRACT_KEYS = [
  'icon',
  'id',
  'label',
  'minRole',
  'order',
  'path',
  'section',
];

const ids = (body) => body.modules.map((m) => m.id);

// Users are seeded directly with their own session tokens so the role matrix can
// be exercised without tripping the login rate limiter.
const SEEDED = [
  { id: 'usr_nav_admin', token: 'nav-admin-token', role: 'admin' },
  { id: 'usr_nav_member', token: 'nav-member-token', role: 'member' },
  { id: 'usr_nav_viewer', token: 'nav-viewer-token', role: 'viewer' },
  // Admin-equivalent alias used elsewhere in the app (`middleware/rbac.js`).
  { id: 'usr_nav_owner', token: 'nav-owner-token', role: 'Owner' },
  // Malformed roles must degrade, never 500.
  { id: 'usr_nav_wizard', token: 'nav-wizard-token', role: 'wizard' },
  { id: 'usr_nav_norole', token: 'nav-norole-token', role: undefined },
];

const tokenFor = (id) => SEEDED.find((user) => user.id === id).token;

let app;

const getModules = (token) => {
  const req = request(app).get('/api/modules');
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};

beforeAll(async () => {
  await resetTestDb();
  const mod = await import('../server.js');
  app = mod.app;
  await mutateDb((db) => {
    for (const seed of SEEDED) {
      const user = {
        id: seed.id,
        name: seed.id,
        email: `${seed.id}@test.com`,
        password: hashPassword('test123'),
        createdAt: new Date().toISOString(),
      };
      if (seed.role !== undefined) user.role = seed.role;
      db.users.push(user);
      db.sessions.push({
        token: seed.token,
        userId: seed.id,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });
    }
  });
}, 30000);

afterAll(() => cleanupTestDb());

describe('GET /api/modules — authentication', () => {
  it('answers 401 without a session token', async () => {
    const res = await getModules();
    expect(res.status).toBe(401);
    expect(res.body.modules).toBeUndefined();
  });

  it('answers 401 for an unrecognized token', async () => {
    const res = await getModules('not-a-real-token');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/modules — role visibility matrix', () => {
  it('admin receives the full module hierarchy', async () => {
    const res = await getModules(tokenFor('usr_nav_admin'));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(ids(res.body)).toEqual(ALL_IDS);
    // The administration section is admin-only and is fully present.
    expect(ids(res.body)).toContain('team');
    expect(ids(res.body)).toContain('settings');
    expect(ids(res.body)).toContain('import_export');
  });

  it('member receives operational modules but no team/workspace administration', async () => {
    const res = await getModules(tokenFor('usr_nav_member'));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(ids(res.body)).toEqual(MEMBER_IDS);
    expect(ids(res.body)).not.toContain('team');
    expect(ids(res.body)).not.toContain('settings');
    // Bulk import/export is an operational member capability, per the matrix.
    expect(ids(res.body)).toContain('import_export');
  });

  it('viewer receives the restricted read-only set', async () => {
    const res = await getModules(tokenFor('usr_nav_viewer'));
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual(VIEWER_IDS);
    for (const excluded of ['leads', 'import_export', 'team', 'settings']) {
      expect(ids(res.body)).not.toContain(excluded);
    }
  });
});

describe('GET /api/modules — graceful degradation', () => {
  it('an unknown role degrades to the viewer set without a 500', async () => {
    const res = await getModules(tokenFor('usr_nav_wizard'));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(ids(res.body)).toEqual(VIEWER_IDS);
  });

  it('a user with no role degrades to the viewer set without a 500', async () => {
    const res = await getModules(tokenFor('usr_nav_norole'));
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual(VIEWER_IDS);
  });

  it('the Owner alias resolves to admin, not to the fallback', async () => {
    const res = await getModules(tokenFor('usr_nav_owner'));
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual(ALL_IDS);
  });
});

describe('GET /api/modules — response contract', () => {
  it('wraps every module in the canonical shape and types', async () => {
    const res = await getModules(tokenFor('usr_nav_admin'));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.modules)).toBe(true);

    for (const item of res.body.modules) {
      expect(Object.keys(item).sort()).toEqual(CONTRACT_KEYS);
      expect(typeof item.id).toBe('string');
      expect(typeof item.label).toBe('string');
      expect(typeof item.path).toBe('string');
      expect(typeof item.icon).toBe('string');
      expect(typeof item.order).toBe('number');
      expect(typeof item.section).toBe('string');
      expect(ROLES).toContain(item.minRole);
    }
  });

  it('orders deterministically by section then order', async () => {
    const first = await getModules(tokenFor('usr_nav_admin'));
    const second = await getModules(tokenFor('usr_nav_admin'));
    expect(ids(second.body)).toEqual(ids(first.body));

    const sectionSeq = first.body.modules.map((m) => m.section);
    const deduped = sectionSeq.filter((s, i) => s !== sectionSeq[i - 1]);
    // Sections are contiguous (never interleaved) ...
    expect(new Set(deduped).size).toBe(deduped.length);
    // ... and modules within each section are ascending by `order`.
    for (const section of new Set(sectionSeq)) {
      const orders = first.body.modules
        .filter((m) => m.section === section)
        .map((m) => m.order);
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
    }
  });
});

describe('navigation service (pure)', () => {
  it('exposes a frozen, non-empty registry with unique ids', () => {
    expect(Array.isArray(MODULES)).toBe(true);
    expect(MODULES.length).toBeGreaterThan(0);
    expect(Object.isFrozen(MODULES)).toBe(true);
    for (const module of MODULES) expect(Object.isFrozen(module)).toBe(true);
    const registryIds = MODULES.map((m) => m.id);
    expect(new Set(registryIds).size).toBe(registryIds.length);
  });

  it('normalizes aliases and rejects junk to the viewer fallback', () => {
    expect(ROLES).toEqual(['viewer', 'member', 'admin']);
    expect(normalizeRole('admin')).toBe('admin');
    expect(normalizeRole('ADMIN')).toBe('admin');
    expect(normalizeRole('  member  ')).toBe('member');
    expect(normalizeRole('Owner')).toBe('admin');
    expect(normalizeRole('owner')).toBe('admin');
    expect(normalizeRole('wizard')).toBe('viewer');
    expect(normalizeRole(undefined)).toBe('viewer');
    expect(normalizeRole(null)).toBe('viewer');
    expect(normalizeRole(42)).toBe('viewer');
    expect(normalizeRole({})).toBe('viewer');
  });

  it('tolerates null/primitive input and returns fresh copies', () => {
    expect(getNavigationForUser(null).map((m) => m.id)).toEqual(VIEWER_IDS);
    expect(getNavigationForUser(undefined).map((m) => m.id)).toEqual(VIEWER_IDS);
    expect(getNavigationForUser({}).map((m) => m.id)).toEqual(VIEWER_IDS);
    expect(getNavigationForUser({ role: 'member' }).map((m) => m.id)).toEqual(
      MEMBER_IDS,
    );

    const first = getNavigationForUser({ role: 'admin' });
    first[0].id = 'tampered';
    first.push({ id: 'injected' });
    const second = getNavigationForUser({ role: 'admin' });
    expect(second.map((m) => m.id)).toEqual(ALL_IDS);
    expect(MODULES[0].id).toBe('dashboard');
  });
});
