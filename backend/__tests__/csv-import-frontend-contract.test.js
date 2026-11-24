import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { cleanupTestDb, loginAs, resetTestDb, seedTestUser } from './setup.js';
import { importFields, parseCsv, prepareRows, runCsvImport } from '../../web/src/components/imports/csvImport.ts';

let app;
let token;

beforeAll(async () => {
  await resetTestDb();
  app = (await import('../server.js')).app;
  await seedTestUser();
  token = await loginAs(app);
});
afterAll(() => cleanupTestDb());

describe('CSV wizard payloads through the record API', () => {
  it.each(['leads', 'contacts', 'companies', 'deals'])('imports %s and excludes invalid rows', async resource => {
    const identity = resource === 'deals' ? 'title' : 'name';
    const numeric = resource === 'companies' ? 'employees' : 'value';
    const fields = importFields(resource, [
      { key: identity, label: 'Name' },
      { key: numeric, label: 'Amount', type: 'number' },
    ]);
    const prepared = prepareRows(parseCsv('Name,Amount\n"CSV, quoted record",12\nInvalid CSV row,not-a-number'), [identity, numeric], fields);
    let requests = 0;
    const results = await runCsvImport(prepared, async payload => {
      requests++;
      const response = await request(app).post(`/api/${resource}`).set('Authorization', `Bearer ${token}`).send(payload);
      if (response.status !== 201) throw Object.assign(new Error(response.body.error || 'Create failed'), { status: response.status });
      return response.body;
    });
    expect(results.map(row => row.status)).toEqual(['imported', 'invalid']);
    expect(requests).toBe(1);
    const saved = await request(app).get(`/api/${resource}/${results[0].id}`).set('Authorization', `Bearer ${token}`);
    expect(saved.status).toBe(200);
    expect(saved.body[identity]).toBe('CSV, quoted record');
    expect(Number(saved.body[numeric])).toBe(12);
  });
});
