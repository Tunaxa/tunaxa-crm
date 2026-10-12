import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import request from 'supertest';
import { closePool } from '../db/pg.js';
import { mutateDb } from '../store.js';
import { resetTestDb, seedTestUser, loginAs } from './setup.js';
import { repositories } from '../db/repositories/index.js';
import {
  DEFAULT_CHUNK_SIZE,
  ExportAbortedError,
  createArraySource,
  createRepositorySource,
  escapeCsvValue,
  exportMetrics,
  humanizeKey,
  resolveColumns,
  serializeCsvBatch,
  serializeCsvHeader,
  serializeCsvRow,
  serializeJsonBatch,
  streamExport,
  writeChunk,
} from '../services/exportStream.js';

// Streaming CSV/JSON exports (P2-BE1-06). Three layers are covered:
//
//   * the pure serializers (RFC 4180 escaping, JSON framing, header labels);
//   * the streaming engine (`streamExport`, `writeChunk`, the source factories)
//     including backpressure, abort-on-disconnect and a 100k-row load run;
//   * the HTTP route (`/api/export/:resource`) for auth, 404, headers, format
//     integrity and a real client socket that hangs up mid-download.

let app;
let token;

const auth = (value = token) => ({ Authorization: `Bearer ${value}` });

/** Minimal RFC 4180 reader used to prove the CSV we emit parses back. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let index = 0;

  while (index < text.length) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }
    if (character === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (character === ',') {
      row.push(field);
      field = '';
      index += 1;
      continue;
    }
    if (character === '\r' && text[index + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 2;
      continue;
    }
    field += character;
    index += 1;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** A Writable that records every chunk so a caller can inspect the stream. */
class CollectSink extends Writable {
  constructor(options) {
    super({ decodeStrings: true, ...options });
    this.chunks = [];
    this.maxChunk = 0;
    this.writeCount = 0;
  }

  _write(chunk, _encoding, callback) {
    this.maxChunk = Math.max(this.maxChunk, chunk.length);
    this.chunks.push(Buffer.from(chunk));
    this.writeCount += 1;
    callback();
  }

  text() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/** A hand-rolled response double for deterministic backpressure tests. */
function createFakeRes({ flush = true } = {}) {
  const listeners = new Map();
  return {
    destroyed: false,
    writableEnded: false,
    writes: [],
    write(chunk) {
      this.writes.push(chunk);
      return flush;
    },
    end() {
      this.writableEnded = true;
    },
    once(event, handler) {
      const handlers = listeners.get(event) || [];
      handlers.push(handler);
      listeners.set(event, handlers);
      return this;
    },
    off(event, handler) {
      const handlers = listeners.get(event) || [];
      listeners.set(event, handlers.filter((item) => item !== handler));
      return this;
    },
    emit(event) {
      const handlers = listeners.get(event) || [];
      listeners.set(event, []);
      for (const handler of handlers) handler();
      return this;
    },
  };
}

function makeRow(index) {
  return {
    id: `lead_${index}`,
    firstName: `First ${index}`,
    lastName: `Last ${index}`,
    email: `lead${index}@example.com`,
    value: index,
  };
}

async function* generateBatches(total, batchSize, onBatch) {
  for (let start = 0; start < total; start += batchSize) {
    const end = Math.min(start + batchSize, total);
    const batch = [];
    for (let index = start; index < end; index += 1) batch.push(makeRow(index));
    onBatch?.(end);
    yield batch;
  }
}

async function waitFor(predicate, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

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

describe('RFC 4180 serialization', () => {
  it('quotes only fields that need it and doubles embedded quotes', () => {
    expect(escapeCsvValue('plain')).toBe('plain');
    expect(escapeCsvValue('North, Inc')).toBe('"North, Inc"');
    expect(escapeCsvValue('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvValue('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCsvValue('cr\rlf')).toBe('"cr\rlf"');
    expect(escapeCsvValue(null)).toBe('');
    expect(escapeCsvValue(undefined)).toBe('');
    expect(escapeCsvValue(0)).toBe('0');
    expect(escapeCsvValue(false)).toBe('false');
    expect(escapeCsvValue({ a: 1 })).toBe('"{""a"":1}"');
  });

  it('serializes a row and a batch with CRLF terminators', () => {
    const columns = ['id', 'name'];
    expect(serializeCsvRow({ id: '1', name: 'A, B' }, columns)).toBe('1,"A, B"');
    expect(
      serializeCsvBatch([{ id: '1', name: 'A' }, { id: '2', name: 'B' }], columns),
    ).toBe('1,A\r\n2,B\r\n');
  });

  it('builds friendly headers from a label map with a humanized fallback', () => {
    expect(humanizeKey('firstName')).toBe('First Name');
    expect(humanizeKey('created_at')).toBe('Created At');
    expect(
      serializeCsvHeader(['first_name', 'unknownField'], { first_name: 'First Name' }),
    ).toBe('First Name,Unknown Field');
  });

  it('derives columns from the first batch in first-seen order', () => {
    const columns = resolveColumns([
      { id: '1', a: 1, b: 2 },
      { id: '2', b: 2, c: 3 },
    ]);
    expect(columns).toEqual(['id', 'a', 'b', 'c']);
    expect(resolveColumns([], ['x', 'y'])).toEqual(['x', 'y']);
  });
});

describe('JSON framing', () => {
  it('emits a valid array across batches without a trailing comma', () => {
    const state = { first: true };
    let out = '[';
    out += serializeJsonBatch([{ a: 1 }, { a: 2 }], state);
    out += serializeJsonBatch([{ a: 3 }], state);
    out += ']';
    expect(JSON.parse(out)).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('serializes an empty stream to an empty array', () => {
    const state = { first: true };
    expect(JSON.parse(`[${serializeJsonBatch([], state)}]`)).toEqual([]);
  });
});

describe('writeChunk backpressure and abort', () => {
  it('parks on drain when the writable reports backpressure', async () => {
    const res = createFakeRes({ flush: false });
    let settled = false;
    const pending = writeChunk(res, 'chunk').then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(res.writes).toEqual(['chunk']);

    res.emit('drain');
    await pending;
    expect(settled).toBe(true);
  });

  it('resolves immediately when the writable has room', async () => {
    const res = createFakeRes({ flush: true });
    await writeChunk(res, 'chunk');
    expect(res.writes).toEqual(['chunk']);
  });

  it('rejects when the socket closes before draining', async () => {
    const res = createFakeRes({ flush: false });
    const pending = writeChunk(res, 'chunk');
    res.emit('close');
    await expect(pending).rejects.toBeInstanceOf(ExportAbortedError);
  });

  it('rejects up front when the abort signal has already fired', async () => {
    const res = createFakeRes();
    const controller = new AbortController();
    controller.abort();
    await expect(writeChunk(res, 'chunk', controller.signal)).rejects.toBeInstanceOf(
      ExportAbortedError,
    );
    expect(res.writes).toEqual([]);
  });

  it('rejects an in-flight write when the signal aborts', async () => {
    const res = createFakeRes({ flush: false });
    const controller = new AbortController();
    const pending = writeChunk(res, 'chunk', controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(ExportAbortedError);
  });
});

describe('streamExport', () => {
  it('streams CSV with a header and bounded per-batch writes', async () => {
    const sink = new CollectSink();
    const result = await streamExport({
      res: sink,
      source: generateBatches(2500, 1000),
      format: 'csv',
      labels: { firstName: 'First Name' },
    });

    expect(result).toMatchObject({ format: 'csv', rowCount: 2500, aborted: false });
    const rows = parseCsv(sink.text());
    expect(rows[0]).toContain('First Name');
    expect(rows).toHaveLength(2501);
    expect(rows[1][0]).toBe('lead_0');
    // One write per batch plus the header: bounded chunking.
    expect(sink.writeCount).toBeLessThanOrEqual(5);
  });

  it('streams JSON that parses cleanly into the source records', async () => {
    const sink = new CollectSink();
    const result = await streamExport({
      res: sink,
      source: generateBatches(2500, 1000),
      format: 'json',
    });
    expect(result.rowCount).toBe(2500);
    const parsed = JSON.parse(sink.text());
    expect(parsed).toHaveLength(2500);
    expect(parsed[0]).toEqual(makeRow(0));
    expect(parsed[2499]).toEqual(makeRow(2499));
  });

  it('honors an explicit column selection', async () => {
    const sink = new CollectSink();
    await streamExport({
      res: sink,
      source: createArraySource([{ id: '1', name: 'A', secret: 'x' }]),
      format: 'csv',
      columns: ['id', 'name'],
    });
    expect(sink.text()).toBe('Id,Name\r\n1,A\r\n');
  });

  it('omits the header row when headers=false', async () => {
    const sink = new CollectSink();
    await streamExport({
      res: sink,
      source: createArraySource([{ id: '1' }]),
      format: 'csv',
      headers: false,
    });
    expect(sink.text()).toBe('1\r\n');
  });

  it('reports aborted=true and stops pulling once the signal fires', async () => {
    const sink = new CollectSink();
    const controller = new AbortController();
    const result = await streamExport({
      res: sink,
      source: generateBatches(100000, 1000),
      format: 'csv',
      signal: controller.signal,
      onBatch: (count) => {
        if (count >= 3000) controller.abort();
      },
    });
    expect(result.aborted).toBe(true);
    expect(result.rowCount).toBe(3000);
    // Nothing after the aborting batch was serialized.
    expect(sink.text().split('\r\n').filter(Boolean).length).toBe(3001);
  });
});

describe('record sources', () => {
  it('stops issuing queries after the abort signal fires', async () => {
    let calls = 0;
    const controller = new AbortController();
    const repo = {
      async findAll({ page, limit }) {
        calls += 1;
        return {
          data: Array.from({ length: limit }, (_, i) => ({ id: `${page}-${i}` })),
          total: 1000000,
          limit,
          page,
        };
      },
    };
    const source = createRepositorySource({
      repo,
      chunkSize: 100,
      signal: controller.signal,
    });
    const iterator = source[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.value).toHaveLength(100);
    expect(calls).toBe(1);

    controller.abort();
    const second = await iterator.next();
    expect(second.done).toBe(true);
    expect(calls).toBe(1);
  });

  it('walks every page until a short page is returned', async () => {
    const pages = [
      { data: Array.from({ length: 3 }, (_, i) => ({ id: `a${i}` })), limit: 3, page: 1 },
      { data: Array.from({ length: 2 }, (_, i) => ({ id: `b${i}` })), limit: 3, page: 2 },
    ];
    let index = 0;
    const repo = {
      findAll: async () => pages[index++],
    };
    const seen = [];
    for await (const batch of createRepositorySource({ repo, chunkSize: 3 })) {
      seen.push(...batch);
    }
    expect(seen.map((row) => row.id)).toEqual(['a0', 'a1', 'a2', 'b0', 'b1']);
  });
});

describe('high-volume load', () => {
  it('streams 100,000 rows in bounded chunks without a heap blowout', async () => {
    const sink = new CollectSink({ highWaterMark: 16384 });
    const heapBefore = process.memoryUsage().heapUsed;

    const result = await streamExport({
      res: sink,
      source: generateBatches(100000, DEFAULT_CHUNK_SIZE),
      format: 'csv',
    });

    const heapAfter = process.memoryUsage().heapUsed;
    const output = sink.text();

    expect(result.rowCount).toBe(100000);
    // Header + 100,000 data lines.
    expect(output.split('\r\n').filter(Boolean)).toHaveLength(100001);
    // One write per batch (plus the header): bounded, not one giant string.
    expect(sink.writeCount).toBeLessThanOrEqual(102);
    expect(sink.maxChunk).toBeLessThan(256 * 1024);
    // The engine holds at most a batch; the only large allocation is the test's
    // own collected output.
    expect(heapAfter - heapBefore).toBeLessThan(400 * 1024 * 1024);
  }, 30000);

  it('streams 100,000 rows as parseable JSON', async () => {
    const sink = new CollectSink({ highWaterMark: 16384 });
    const result = await streamExport({
      res: sink,
      source: generateBatches(100000, DEFAULT_CHUNK_SIZE),
      format: 'json',
    });
    expect(result.rowCount).toBe(100000);
    const parsed = JSON.parse(sink.text());
    expect(parsed).toHaveLength(100000);
    expect(parsed[0].id).toBe('lead_0');
    expect(parsed[99999].id).toBe('lead_99999');
  }, 30000);
});

describe('GET /api/export/:resource', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/export/contacts');
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown resource', async () => {
    const res = await request(app)
      .get('/api/export/not-a-real-resource')
      .set(auth());
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Unknown export resource/i);
  });

  it('rejects an unsupported format', async () => {
    const res = await request(app)
      .get('/api/export/contacts?format=xml')
      .set(auth());
    expect(res.status).toBe(400);
  });

  it('rejects a prototype-polluting column selection', async () => {
    const res = await request(app)
      .get('/api/export/contacts?columns=__proto__')
      .set(auth());
    expect(res.status).toBe(400);
  });

  it('streams contacts as a chunked CSV download', async () => {
    const created = await request(app)
      .post('/api/contacts')
      .set(auth())
      .send({ firstName: 'North, "Division"', lastName: 'Lovelace', email: 'north@example.com' });
    expect(created.status).toBe(201);

    const res = await request(app)
      .get('/api/export/contacts?format=csv')
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('contacts-export.csv');
    expect(res.headers['transfer-encoding']).toBe('chunked');
    expect(res.text).toContain('"North, ""Division"""');

    const table = parseCsv(res.text);
    expect(table[0]).toContain('First Name');
    const header = table[0];
    const nameIndex = header.indexOf('First Name');
    expect(nameIndex).toBeGreaterThanOrEqual(0);
    // The escaped value round-trips back to the original unescaped string.
    expect(table.some((row) => row[nameIndex] === 'North, "Division"')).toBe(true);
  });

  it('streams JSON that parses into an array of records', async () => {
    await request(app)
      .post('/api/contacts')
      .set(auth())
      .send({ firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.com' });

    const res = await request(app)
      .get('/api/export/contacts?format=json')
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toContain('contacts-export.json');
    const records = JSON.parse(res.text);
    expect(Array.isArray(records)).toBe(true);
    expect(records.some((record) => record.first_name === 'Grace')).toBe(true);
  });

  it('exports a JSON-store resource with selected columns', async () => {
    await mutateDb((db) => {
      db.landingPages = [
        { id: 'lp_1', name: 'One', views: 10 },
        { id: 'lp_2', name: 'Two, "quoted"', views: 20 },
      ];
    });

    const res = await request(app)
      .get('/api/export/landingPages?format=csv&columns=id,name')
      .set(auth());

    expect(res.status).toBe(200);
    const table = parseCsv(res.text);
    expect(table[0]).toEqual(['Id', 'Name']);
    expect(table[1]).toEqual(['lp_1', 'One']);
    expect(table[2]).toEqual(['lp_2', 'Two, "quoted"']);
  });

  it('stops querying and aborts when the client socket closes mid-stream', async () => {
    // A per-page delay makes the traversal deterministic: the client hangs up
    // while the server is genuinely still paging, instead of racing a fully
    // buffered response.
    const original = repositories.contacts;
    let calls = 0;
    repositories.contacts = {
      async findAll({ page, limit }) {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          data: Array.from({ length: limit }, (_, index) => ({
            id: `c_${page}_${index}`,
            first_name: 'Synthetic',
            last_name: 'Row',
            email: `c_${page}_${index}@example.com`,
          })),
          total: 1000000,
          limit,
          page,
        };
      },
    };

    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const abortedBefore = exportMetrics.aborted;

    try {
      await new Promise((resolve) => {
        const req = http.get(
          {
            host: '127.0.0.1',
            port: address.port,
            path: '/api/export/contacts?format=csv',
            headers: auth(),
          },
          (res) => {
            res.on('error', () => {});
            res.once('data', () => {
              res.destroy();
              resolve();
            });
            res.once('end', resolve);
          },
        );
        req.once('error', resolve);
        req.setTimeout(8000, () => {
          req.destroy();
          resolve();
        });
      });

      expect(
        await waitFor(() => exportMetrics.aborted > abortedBefore, 5000),
      ).toBe(true);

      // Once aborted, the cursor issues no further query.
      const settledCalls = calls;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(calls).toBe(settledCalls);
    } finally {
      repositories.contacts = original;
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  }, 30000);
});
