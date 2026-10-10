import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { resetTestDb, cleanupTestDb, seedTestUser, loginAs } from './setup.js';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  buildPaginationEnvelope,
  normalizeListQuery,
  sortRecords,
  toRepositorySort,
  wantsEnvelope,
} from '../middleware/pagination.js';

let app;
let token;

beforeAll(async () => {
  await resetTestDb();
  const mod = await import('../server.js');
  app = mod.app;
  await seedTestUser();
  token = await loginAs(app);
});

afterAll(async () => {
  await cleanupTestDb();
});

const auth = () => ({ Authorization: `Bearer ${token}` });

describe('normalizeListQuery defaults', () => {
  it('applies the documented defaults when parameters are omitted', () => {
    expect(normalizeListQuery({})).toEqual({
      page: 1,
      limit: DEFAULT_LIMIT,
      sortBy: 'createdAt',
      sortDir: 'desc',
    });
  });

  it('is defensive about a missing or non-object query', () => {
    expect(normalizeListQuery(null).page).toBe(1);
    expect(normalizeListQuery(undefined).limit).toBe(DEFAULT_LIMIT);
  });

  it('normalizes the direction case-insensitively', () => {
    expect(normalizeListQuery({ sortDir: 'ASC' }).sortDir).toBe('asc');
    expect(normalizeListQuery({ sortDir: 'Desc' }).sortDir).toBe('desc');
  });
});

describe('normalizeListQuery clamping and rejection', () => {
  it('clamps limits above the maximum to MAX_LIMIT', () => {
    expect(normalizeListQuery({ limit: String(MAX_LIMIT + 1) }).limit).toBe(
      MAX_LIMIT,
    );
    expect(normalizeListQuery({ limit: '999999' }).limit).toBe(MAX_LIMIT);
  });

  it('clamps pages below 1 to the default page', () => {
    expect(normalizeListQuery({ page: '-7' }).page).toBe(1);
    expect(normalizeListQuery({ page: '0' }).page).toBe(1);
  });

  it('falls back to the default limit for zero, negative and non-numeric input', () => {
    expect(normalizeListQuery({ limit: '0' }).limit).toBe(DEFAULT_LIMIT);
    expect(normalizeListQuery({ limit: '-5' }).limit).toBe(DEFAULT_LIMIT);
    expect(normalizeListQuery({ limit: 'abc' }).limit).toBe(DEFAULT_LIMIT);
    expect(normalizeListQuery({ page: 'abc' }).page).toBe(1);
  });

  it('truncates fractional input to an integer', () => {
    expect(normalizeListQuery({ page: '2.9' }).page).toBe(2);
    expect(normalizeListQuery({ limit: '5.5' }).limit).toBe(5);
  });

  it('ignores repeated parameters that arrive as arrays', () => {
    expect(normalizeListQuery({ limit: ['10', '20'] }).limit).toBe(DEFAULT_LIMIT);
    expect(normalizeListQuery({ page: ['2', '3'] }).page).toBe(1);
  });
});

describe('normalizeListQuery sort sanitization', () => {
  it('rejects prototype-pollution and unsafe field names', () => {
    const unsafe = [
      '__proto__',
      'constructor',
      'prototype',
      'a.b',
      'a b',
      'name;DROP TABLE',
      '',
    ];
    for (const field of unsafe) {
      expect(normalizeListQuery({ sortBy: field }).sortBy).toBe('createdAt');
    }
  });

  it('keeps safe camelCase and snake_case field names', () => {
    expect(normalizeListQuery({ sortBy: 'firstName' }).sortBy).toBe('firstName');
    expect(normalizeListQuery({ sortBy: 'first_name' }).sortBy).toBe('first_name');
  });

  it('supports the legacy field:direction spelling', () => {
    expect(normalizeListQuery({ sortBy: 'created_at:asc' })).toMatchObject({
      sortBy: 'created_at',
      sortDir: 'asc',
    });
  });

  it('lets an explicit sortDir win over the inline direction', () => {
    expect(
      normalizeListQuery({ sortBy: 'created_at:asc', sortDir: 'desc' }),
    ).toMatchObject({ sortBy: 'created_at', sortDir: 'desc' });
  });

  it('falls back to desc for an invalid direction', () => {
    expect(normalizeListQuery({ sortDir: 'sideways' }).sortDir).toBe('desc');
  });
});

describe('toRepositorySort', () => {
  it('converts camelCase controls to column:direction', () => {
    expect(toRepositorySort('createdAt', 'desc')).toBe('created_at:desc');
    expect(toRepositorySort('closeDate', 'asc')).toBe('close_date:asc');
    expect(toRepositorySort('created_at', 'ASC')).toBe('created_at:asc');
  });

  it('normalizes an invalid direction to desc', () => {
    expect(toRepositorySort('createdAt', 'nope')).toBe('created_at:desc');
  });
});

describe('wantsEnvelope', () => {
  it('only accepts explicit truthy opt-ins', () => {
    expect(wantsEnvelope({})).toBe(false);
    expect(wantsEnvelope({ envelope: 'false' })).toBe(false);
    expect(wantsEnvelope({ envelope: 'true' })).toBe(true);
    expect(wantsEnvelope({ envelope: '1' })).toBe(true);
    expect(wantsEnvelope({ envelope: 'yes' })).toBe(true);
  });
});

describe('buildPaginationEnvelope', () => {
  it('produces consistent metadata and totalPages', () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    expect(buildPaginationEnvelope(rows, 5, { page: 1, limit: 2 })).toEqual({
      data: rows,
      page: 1,
      limit: 2,
      total: 5,
      totalPages: 3,
    });
  });

  it('reports zero totalPages for an empty result set', () => {
    expect(
      buildPaginationEnvelope([], 0, { page: 1, limit: 20 }),
    ).toMatchObject({ total: 0, totalPages: 0 });
  });

  it('clamps the echoed page and limit', () => {
    const envelope = buildPaginationEnvelope([], 0, { page: 0, limit: 5000 });
    expect(envelope.page).toBe(1);
    expect(envelope.limit).toBe(MAX_LIMIT);
  });
});

describe('sortRecords', () => {
  const rows = [
    { id: 'b', value: 2, label: 'bravo' },
    { id: 'a', value: 1, label: 'Alpha' },
    { id: 'c', value: null, label: 'charlie' },
  ];

  it('sorts ascending and descending by numeric fields with nulls last', () => {
    expect(sortRecords(rows, 'value', 'asc').map((row) => row.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(sortRecords(rows, 'value', 'desc').map((row) => row.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('sorts case-insensitively by string fields', () => {
    expect(sortRecords(rows, 'label', 'asc').map((row) => row.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(sortRecords(rows, 'label', 'desc').map((row) => row.id)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  it('keeps the original order when the field is missing everywhere', () => {
    expect(sortRecords(rows, 'missing', 'asc').map((row) => row.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('does not mutate the input array', () => {
    const input = [...rows];
    sortRecords(input, 'value', 'asc');
    expect(input.map((row) => row.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('GET /api/leads list contract', () => {
  beforeAll(async () => {
    const leads = [
      { name: 'Alpha Lead', email: 'alpha@example.com' },
      { name: 'Bravo Lead', email: 'bravo@example.com' },
      { name: 'Charlie Lead', email: 'charlie@example.com' },
    ];
    for (const lead of leads) {
      const created = await request(app).post('/api/leads').set(auth()).send(lead);
      expect(created.status).toBe(201);
    }
  });

  it('keeps the legacy bare array by default', async () => {
    const res = await request(app).get('/api/leads').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(3);
  });

  it('returns the uniform envelope with defaults for ?envelope=true', async () => {
    const res = await request(app).get('/api/leads?envelope=true').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1, limit: DEFAULT_LIMIT });
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.total).toBeGreaterThanOrEqual(3);
    expect(res.body.totalPages).toBe(
      Math.ceil(res.body.total / res.body.limit),
    );
  });

  it('pages and reports consistent metadata', async () => {
    const res = await request(app)
      .get('/api/leads?envelope=true&page=1&limit=2')
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(2);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(3);
    expect(res.body.totalPages).toBe(2);
  });

  it('clamps an out-of-bounds limit and a negative page', async () => {
    const tooBig = await request(app)
      .get('/api/leads?envelope=true&limit=999999')
      .set(auth());
    expect(tooBig.body.limit).toBe(MAX_LIMIT);

    const negative = await request(app)
      .get('/api/leads?envelope=true&page=-4')
      .set(auth());
    expect(negative.body.page).toBe(1);
  });

  it('honours sortBy and sortDir ordering', async () => {
    const asc = await request(app)
      .get('/api/leads?envelope=true&sortBy=email&sortDir=asc&limit=100')
      .set(auth());
    expect(asc.status).toBe(200);
    expect(asc.body.data[0].email).toBe('alpha@example.com');
    expect(asc.body.data.at(-1).email).toBe('charlie@example.com');

    const desc = await request(app)
      .get('/api/leads?envelope=true&sortBy=email&sortDir=desc&limit=100')
      .set(auth());
    expect(desc.status).toBe(200);
    expect(desc.body.data[0].email).toBe('charlie@example.com');
    expect(desc.body.data.at(-1).email).toBe('alpha@example.com');
  });

  it('keeps the bare-array contract when paging without the envelope', async () => {
    const res = await request(app)
      .get('/api/leads?page=1&limit=1&sortBy=name&sortDir=asc')
      .set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
  });

  it('sanitizes a prototype-pollution sortBy', async () => {
    const res = await request(app)
      .get('/api/leads?envelope=true&sortBy=__proto__&sortDir=asc')
      .set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('GET /api/pipeline/definitions list contract', () => {
  it('keeps the bare array default and supports the envelope opt-in', async () => {
    const created = await request(app)
      .post('/api/pipeline/definitions')
      .set(auth())
      .send({ name: 'Query Contract Pipeline', stages: [] });
    expect(created.status).toBe(201);

    const bare = await request(app)
      .get('/api/pipeline/definitions')
      .set(auth());
    expect(bare.status).toBe(200);
    expect(Array.isArray(bare.body)).toBe(true);

    const envelope = await request(app)
      .get('/api/pipeline/definitions?envelope=true&limit=100')
      .set(auth());
    expect(envelope.status).toBe(200);
    expect(envelope.body).toMatchObject({ page: 1, limit: 100 });
    expect(Array.isArray(envelope.body.data)).toBe(true);
    expect(envelope.body.total).toBe(envelope.body.data.length);
  });
});
