import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { closePool, query } from '../db/pg.js';
import { readDb } from '../store.js';
import { resetTestDb, seedTestUser, loginAs } from './setup.js';
import { buildResourceSchema } from '../services/schema.js';
import {
  parseCsv,
  buildDefaultMapping,
  validateRecord,
} from '../services/csvImport.js';

// CSV import backend (P2-BE2-04). Integration tests over the HTTP surface:
// dry-run isolation, real-run persistence, custom/automatic column mapping,
// validation failures, downloadable error reports and auth guards. A handful of
// pure service tests pin the parser edge cases directly.

let app;
let token;

const auth = () => ({ Authorization: `Bearer ${token}` });

const doImport = (resource, body) =>
  request(app).post(`/api/import/${resource}`).set(auth()).send(body);

const countRows = async (resource) => {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS count FROM ${resource}`,
  );
  return rows[0].count;
};

beforeAll(async () => {
  await resetTestDb();
  const mod = await import('../server.js');
  app = mod.app;
  await seedTestUser();
  token = await loginAs(app);
});

afterAll(async () => {
  await closePool();
});

describe('authentication', () => {
  it('returns 401 for an unauthenticated import', async () => {
    const res = await request(app)
      .post('/api/import/contacts')
      .send({ csv: 'Email\nada@example.com\n', dryRun: true });
    expect(res.status).toBe(401);
  });

  it('protects the error-report endpoints', async () => {
    expect((await request(app).get('/api/import/errors/whatever')).status).toBe(
      401,
    );
    expect(
      (await request(app).post('/api/import/error-report').send({})).status,
    ).toBe(401);
  });
});

describe('dry run', () => {
  it('reports valid and invalid rows without writing anything', async () => {
    const csv = [
      'Full Name,Email,Phone',
      'Ada Lovelace,ada@example.com,+1 555 000 0000',
      'Grace Hopper,not-an-email,555',
      'Alan Turing,alan@example.com,555',
    ].join('\n');

    const before = await countRows('contacts');
    const auditBefore = (await readDb()).audit.length;

    const res = await doImport('contacts', { csv, dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.totalRows).toBe(3);
    expect(res.body.validRows).toBe(2);
    expect(res.body.invalidRows).toBe(1);
    expect(res.body.importedCount).toBe(0);
    expect(res.body.errorCount).toBe(1);
    expect(res.body.errors[0].row).toBe(2);
    expect(res.body.errors[0].errors.join(' ')).toMatch(/valid email/i);
    expect(res.body.errorReportId).toBeTruthy();

    // The guardrail: neither the repository nor the JSON store changed.
    expect(await countRows('contacts')).toBe(before);
    expect((await readDb()).audit.length).toBe(auditBefore);
  });
});

describe('real run', () => {
  it('persists valid rows and makes them queryable', async () => {
    const csv = [
      'First Name,Last Name,Email',
      'Ada,Lovelace,ada.run@example.com',
      'Grace,Hopper,grace.run@example.com',
    ].join('\n');

    const res = await doImport('contacts', { csv, dryRun: false });

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(false);
    expect(res.body.importedCount).toBe(2);
    expect(res.body.errorCount).toBe(0);

    const { rows } = await query(
      'SELECT first_name, last_name, email FROM contacts WHERE email IN ($1, $2) ORDER BY email',
      ['ada.run@example.com', 'grace.run@example.com'],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada.run@example.com',
    });

    const db = await readDb();
    expect(
      db.audit.some((entry) =>
        /Imported 2 contacts from CSV/.test(entry.action),
      ),
    ).toBe(true);
  });

  it('isolates invalid rows and still imports the valid ones', async () => {
    const csv = [
      'First Name,Email',
      'Valid One,valid.one@example.com',
      'Broken Row,bad-email',
      'Valid Two,valid.two@example.com',
    ].join('\n');

    const res = await doImport('contacts', { csv, dryRun: false });

    expect(res.status).toBe(200);
    expect(res.body.importedCount).toBe(2);
    expect(res.body.errorCount).toBe(1);
    expect(res.body.errors[0].row).toBe(2);

    const good = await query(
      "SELECT COUNT(*)::int AS count FROM contacts WHERE email IN ('valid.one@example.com', 'valid.two@example.com')",
    );
    expect(good.rows[0].count).toBe(2);

    const bad = await query(
      "SELECT COUNT(*)::int AS count FROM contacts WHERE email = 'bad-email'",
    );
    expect(bad.rows[0].count).toBe(0);
  });

  it('honours custom column mapping for non-standard headers', async () => {
    const res = await doImport('contacts', {
      csv: 'Contact Person,Work E-mail\nAda Lovelace,ada.map@example.com\n',
      mapping: { 'Contact Person': 'name', 'Work E-mail': 'email' },
      dryRun: false,
    });

    expect(res.status).toBe(200);
    expect(res.body.importedCount).toBe(1);

    const { rows } = await query(
      'SELECT first_name, last_name, email FROM contacts WHERE email = $1',
      ['ada.map@example.com'],
    );
    expect(rows[0]).toMatchObject({
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada.map@example.com',
    });
  });

  it('parses a BOM, CRLF line endings and commas inside quotes', async () => {
    const csv =
      '\uFEFFFirst Name,Last Name,Email,Phone\r\n"Ada","Love, lace",ada.quoted@example.com,"+1 555, 0000"\r\n';

    const res = await doImport('contacts', { csv, dryRun: false });

    expect(res.status).toBe(200);
    expect(res.body.importedCount).toBe(1);

    const { rows } = await query(
      'SELECT first_name, last_name, phone FROM contacts WHERE email = $1',
      ['ada.quoted@example.com'],
    );
    expect(rows[0]).toMatchObject({
      first_name: 'Ada',
      last_name: 'Love, lace',
      phone: '+1 555, 0000',
    });
  });
});

describe('validation', () => {
  it('catches a missing required field', async () => {
    const res = await doImport('companies', {
      csv: 'Domain,Industry\nacme.com,Widgets\n',
      dryRun: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.invalidRows).toBe(1);
    expect(res.body.errors[0].errors.join(' ')).toMatch(/Company Name is required/i);
  });

  it('catches a missing required deal name, a non-number and a non-positive value', async () => {
    const csv = [
      'Deal Name,Value',
      ',1000',
      'Renewal,not-a-number',
      'Downgrade,-5',
    ].join('\n');

    const res = await doImport('deals', { csv, dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.totalRows).toBe(3);
    expect(res.body.invalidRows).toBe(3);
    expect(res.body.errors[0].errors.join(' ')).toMatch(/required/i);
    expect(res.body.errors[1].errors.join(' ')).toMatch(/must be a number/i);
    expect(res.body.errors[2].errors.join(' ')).toMatch(/positive number/i);
  });

  it('flags a malformed row whose column count does not match the header', async () => {
    const csv = [
      'First Name,Email',
      'Ada,ada@example.com,extra',
      'Bob,bob@example.com',
    ].join('\n');

    const res = await doImport('contacts', { csv, dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.invalidRows).toBe(1);
    expect(res.body.validRows).toBe(1);
    expect(res.body.errors[0].errors.join(' ')).toMatch(/header defines 2/i);
  });

  it('rejects an unknown resource', async () => {
    const res = await doImport('widgets', {
      csv: 'Name\nThing\n',
      dryRun: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contacts, leads, companies, deals/);
  });

  it('rejects an empty payload and a header-only CSV', async () => {
    expect((await doImport('contacts', { csv: '', dryRun: true })).status).toBe(
      400,
    );
    expect(
      (await doImport('contacts', { csv: 'Email\n', dryRun: true })).status,
    ).toBe(400);
  });

  it('rejects a CSV whose columns cannot be mapped', async () => {
    const res = await doImport('contacts', {
      csv: 'Foo,Bar\n1,2\n',
      dryRun: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mapped/i);
  });

  it('rejects a mapping that names an unknown column or field', async () => {
    const unknownColumn = await doImport('contacts', {
      csv: 'Email\nada@example.com\n',
      mapping: { Nope: 'email' },
      dryRun: true,
    });
    expect(unknownColumn.status).toBe(400);
    expect(unknownColumn.body.error).toMatch(/unknown CSV column/i);

    const unknownField = await doImport('contacts', {
      csv: 'Email\nada@example.com\n',
      mapping: { Email: 'nope' },
      dryRun: true,
    });
    expect(unknownField.status).toBe(400);
    expect(unknownField.body.error).toMatch(/Unknown or read-only/i);
  });

  it('rejects a mapping onto a read-only system field', async () => {
    const res = await doImport('contacts', {
      csv: 'Email\nada@example.com\n',
      mapping: { Email: 'createdAt' },
      dryRun: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/read-only/i);
  });

  it('rejects a CSV above the row cap', async () => {
    const rows = ['Email'];
    for (let i = 0; i < 1001; i += 1) rows.push(`user${i}@example.com`);
    const res = await doImport('contacts', {
      csv: rows.join('\n'),
      dryRun: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Maximum 1000 rows/i);
  });
});

describe('error report', () => {
  it('generates a downloadable CSV with the failed rows and reasons', async () => {
    const res = await doImport('contacts', {
      csv: 'Full Name,Email\nGrace,not-an-email\n',
      dryRun: true,
    });
    expect(res.status).toBe(200);
    const reportId = res.body.errorReportId;
    expect(reportId).toBeTruthy();

    const download = await request(app)
      .get(`/api/import/errors/${reportId}`)
      .set(auth());

    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toMatch(/text\/csv/);
    expect(download.headers['content-disposition']).toMatch(
      /attachment; filename="import-errors.csv"/,
    );
    expect(download.text).toContain('Full Name,Email,_errors');
    expect(download.text).toContain('Grace,not-an-email');
    expect(download.text).toMatch(/valid email/i);
  });

  it('also serves the report through POST /api/import/error-report', async () => {
    const res = await doImport('contacts', {
      csv: 'Email\nnope\n',
      dryRun: true,
    });
    const post = await request(app)
      .post('/api/import/error-report')
      .set(auth())
      .send({ reportId: res.body.errorReportId });

    expect(post.status).toBe(200);
    expect(post.headers['content-disposition']).toMatch(/attachment/);
    expect(post.text).toMatch(/valid email/i);
  });

  it('404s for an unknown or expired report id', async () => {
    const res = await request(app)
      .get('/api/import/errors/importError_does_not_exist')
      .set(auth());
    expect(res.status).toBe(404);
  });
});

describe('service: parseCsv', () => {
  it('handles quoted commas, escaped quotes, embedded newlines, CRLF and a BOM', () => {
    const parsed = parseCsv(
      '\uFEFFname,notes,amount\r\n"Ada, A.","say ""hi""\nsecond line",10\r\n',
    );
    expect(parsed.headers).toEqual(['name', 'notes', 'amount']);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].values).toEqual([
      'Ada, A.',
      'say "hi"\nsecond line',
      '10',
    ]);
    expect(parsed.rows[0].index).toBe(1);
  });

  it('ignores blank lines and trailing newlines', () => {
    const parsed = parseCsv('a,b\n\n1,2\n\n');
    expect(parsed.headers).toEqual(['a', 'b']);
    expect(parsed.rows).toHaveLength(1);
  });
});

describe('service: mapping and validation', () => {
  it('auto-maps friendly header aliases onto the reflected schema', () => {
    const schema = buildResourceSchema('deals', { db: {} });
    const mapping = buildDefaultMapping(
      ['Deal Name', 'Amount', 'Pipeline Stage', 'Company', 'Expected Close Date'],
      schema,
    );
    expect(mapping).toEqual({
      'Deal Name': 'title',
      Amount: 'value',
      'Pipeline Stage': 'stage',
      Company: 'company',
      'Expected Close Date': 'closeDate',
    });
  });

  it('canonicalises record values with the reflected field names', () => {
    const schema = buildResourceSchema('contacts', { db: {} });
    const errors = validateRecord(
      { email: 'not-an-email', phone: '555' },
      schema,
      'contacts',
    );
    expect(errors.join(' ')).toMatch(/valid email/i);
  });
});
