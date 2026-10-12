// Streaming CSV/JSON export engine (P2-BE1-06).
//
// The legacy `GET /api/:resource/export.csv` handler materialised the whole
// result set (`pgFindAll` / `db[resource]`) and then wrote a serialized string
// per row with `res.write`. That is fine for a few hundred rows and pathological
// for a hundred thousand: the array, the intermediate strings and the socket
// buffer all live at once, the event loop blocks on the synchronous serialize
// loop, and the gateway times the request out before the last byte ships.
//
// This module is the streaming replacement. It is deliberately split so each
// piece is independently testable:
//
//   * pure serializers  - RFC 4180 CSV escaping and the JSON array framing;
//   * `writeChunk`      - a backpressure-aware write that resolves on `drain`
//                         and rejects the moment the socket closes or an abort
//                         signal fires;
//   * `streamExport`    - the orchestrator that pulls batches from a source,
//                         serializes one batch at a time and writes it;
//   * source factories  - `createArraySource` (JSON store) and
//                         `createRepositorySource` (offset/keyset-style paging
//                         over a Postgres repository).
//
// Memory overhead is O(chunkSize), not O(dataset): the orchestrator awaits each
// write before pulling the next batch, and a batch is serialized into a single
// bounded string. Nothing accumulates across batches.

export const DEFAULT_CHUNK_SIZE = 1000;
export const MAX_CHUNK_SIZE = 5000;

/** Raised when the client disconnects (or an AbortSignal fires) mid-stream. */
export class ExportAbortedError extends Error {
  constructor(message = 'Export aborted: client disconnected') {
    super(message);
    this.name = 'ExportAbortedError';
    this.code = 'EXPORT_ABORTED';
  }
}

// Lightweight in-process telemetry. Every export funnel is long-running and the
// interesting signal in production is "did we finish, disconnect, and how many
// rows did we move". Keeping counters here means the route stays declarative and
// tests can observe completion/abort without reaching into the socket.
export const exportMetrics = {
  requests: 0,
  completed: 0,
  aborted: 0,
  rowsStreamed: 0,
  bytesStreamed: 0,
};

export function isAborted(signal) {
  return Boolean(signal && signal.aborted);
}

/** `firstName` -> `First Name`, `created_at` -> `Created At`. */
export function humanizeKey(key) {
  return String(key)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * RFC 4180 field serialization with minimal quoting: a field is quoted only
 * when it contains a comma, a double quote, a carriage return or a line feed,
 * and embedded quotes are doubled. Objects are JSON-encoded so a nested custom
 * field survives the round trip instead of rendering `[object Object]`.
 */
export function escapeCsvValue(value) {
  if (value === null || value === undefined) return '';
  const text =
    typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (text === '') return '';
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** One record as a single CSV record (no trailing newline). */
export function serializeCsvRow(record, columns) {
  return columns.map((column) => escapeCsvValue(record?.[column])).join(',');
}

/** A whole batch of records, CRLF-terminated, as one bounded string. */
export function serializeCsvBatch(records, columns) {
  let out = '';
  for (const record of records) {
    out += `${serializeCsvRow(record, columns)}\r\n`;
  }
  return out;
}

/** CSV header row, labelled through `labels` and falling back to a humanized key. */
export function serializeCsvHeader(columns, labels) {
  return columns
    .map((column) => {
      const label =
        labels && typeof labels === 'object' && labels[column]
          ? labels[column]
          : humanizeKey(column);
      return escapeCsvValue(label);
    })
    .join(',');
}

/**
 * Serialize one batch into the JSON array framing. `state.first` tracks whether
 * a comma separator is required, so the caller can stream record after record
 * without ever holding the full document in memory. The result is always valid
 * when wrapped in `[` ... `]`.
 */
export function serializeJsonBatch(records, state) {
  let out = '';
  for (const record of records) {
    out += `${state.first ? '' : ','}${JSON.stringify(record ?? null)}`;
    state.first = false;
  }
  return out;
}

/**
 * Union of the keys actually present in a batch, in first-seen order. Used to
 * derive a CSV header lazily from the first batch so the engine can start
 * streaming immediately without a counting pre-pass. The JSON store keeps
 * homogeneous arrays and a `SELECT *` row always carries every column, so the
 * first batch is representative.
 */
export function resolveColumns(records, explicit) {
  if (Array.isArray(explicit) && explicit.length) return explicit.slice();
  const columns = [];
  const seen = new Set();
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    for (const key of Object.keys(record)) {
      if (key === '__proto__' || seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  return columns;
}

/**
 * Write one chunk, resolving when the writable has room for the next one.
 *
 * `res.write` returning `false` is the backpressure signal: we park on the
 * `drain` event rather than continuing to build an unbounded socket buffer. The
 * same race also watches `close`/`error` and an optional `AbortSignal`, so a
 * client that hangs up mid-export terminates the write immediately instead of
 * after the remaining dataset has been serialized.
 */
export function writeChunk(res, chunk, signal) {
  return new Promise((resolve, reject) => {
    if (
      isAborted(signal) ||
      res.writableEnded ||
      res.destroyed
    ) {
      reject(new ExportAbortedError());
      return;
    }

    let settled = false;
    const onDrain = () => finish();
    const onClose = () => finish(new ExportAbortedError());
    const onError = (error) => finish(error);
    const onAbort = () => finish(new ExportAbortedError());

    function cleanup() {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    }

    function finish(error) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    }

    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    let flushed;
    try {
      flushed = res.write(chunk, (error) => {
        if (error) finish(error);
      });
    } catch (error) {
      finish(error);
      return;
    }
    if (flushed) finish();
  });
}

/**
 * Stream a record source to an HTTP response.
 *
 * @param {object}   options
 * @param {object}   options.res       Express response (or any writable).
 * @param {Iterable|AsyncIterable|Function} options.source  batches of records.
 * @param {'csv'|'json'} [options.format]
 * @param {string[]} [options.columns] explicit column order/selection.
 * @param {object}   [options.labels]  column -> friendly header label.
 * @param {boolean}  [options.headers] emit the CSV header row (default true).
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{format:string,rowCount:number,columns:string[],aborted:boolean}>}
 */
export async function streamExport(options) {
  const {
    res,
    source: rawSource,
    format = 'csv',
    columns: explicitColumns = null,
    labels = null,
    headers = true,
    signal,
    onBatch,
  } = options || {};

  const normalizedFormat = format === 'json' ? 'json' : 'csv';
  const source =
    rawSource && typeof rawSource[Symbol.asyncIterator] === 'function'
      ? rawSource
      : rawSource && typeof rawSource[Symbol.iterator] === 'function'
        ? rawSource
        : typeof rawSource === 'function'
          ? rawSource()
          : null;

  if (!source) throw new TypeError('streamExport requires an iterable source');
  if (!res || typeof res.write !== 'function') {
    throw new TypeError('streamExport requires a writable response');
  }

  let columns =
    Array.isArray(explicitColumns) && explicitColumns.length
      ? explicitColumns.slice()
      : null;
  let wroteHeader = false;
  let rowCount = 0;
  const jsonState = { first: true };

  try {
    if (normalizedFormat === 'json') {
      await writeChunk(res, '[', signal);
    }

    for await (const batch of source) {
      if (isAborted(signal)) throw new ExportAbortedError();
      const records = Array.isArray(batch) ? batch : batch == null ? [] : [batch];
      if (!records.length) continue;

      if (normalizedFormat === 'csv') {
        if (!columns) columns = resolveColumns(records, explicitColumns);
        if (!wroteHeader && headers) {
          await writeChunk(res, `${serializeCsvHeader(columns, labels)}\r\n`, signal);
          wroteHeader = true;
        }
        const chunk = serializeCsvBatch(records, columns);
        await writeChunk(res, chunk, signal);
        exportMetrics.bytesStreamed += chunk.length;
      } else {
        const chunk = serializeJsonBatch(records, jsonState);
        await writeChunk(res, chunk, signal);
        exportMetrics.bytesStreamed += chunk.length;
      }

      rowCount += records.length;
      if (typeof onBatch === 'function') onBatch(rowCount);
    }

    // A client that disconnected while the last batch was being written must
    // not be handed a "successful" close; surface the abort instead.
    if (isAborted(signal)) throw new ExportAbortedError();

    // A CSV dataset with zero rows still gets a header when the columns are
    // known up front (either supplied or derived from an empty batch).
    if (normalizedFormat === 'csv' && headers && !wroteHeader) {
      columns = columns || resolveColumns([], explicitColumns);
      if (columns.length) {
        await writeChunk(res, `${serializeCsvHeader(columns, labels)}\r\n`, signal);
      }
    }

    if (normalizedFormat === 'json') {
      await writeChunk(res, ']', signal);
    }

    if (!res.writableEnded && !res.destroyed) res.end();
    return { format: normalizedFormat, rowCount, columns: columns || [], aborted: false };
  } catch (error) {
    if (error instanceof ExportAbortedError) {
      // The client is gone; there is nobody left to write to. Tear the socket
      // down if it is still half-open and report the abort upward rather than
      // surfacing it as an unhandled rejection.
      if (!res.destroyed && !res.writableEnded) {
        try {
          res.end();
        } catch {
          /* socket already torn down */
        }
      }
      return { format: normalizedFormat, rowCount, columns: columns || [], aborted: true };
    }
    throw error;
  }
}

/** Async source over an in-memory array, sliced into bounded batches. */
export function createArraySource(
  records,
  { chunkSize = DEFAULT_CHUNK_SIZE, signal, mapRecord } = {},
) {
  const list = Array.isArray(records) ? records : [];
  const size = clampChunkSize(chunkSize);
  const map = typeof mapRecord === 'function' ? mapRecord : (record) => record;

  return (async function* iterate() {
    for (let index = 0; index < list.length; index += size) {
      if (isAborted(signal)) return;
      yield list.slice(index, index + size).map(map);
    }
  })();
}

/**
 * Async source over a Postgres repository.
 *
 * The repository owns the SQL; this driver owns the traversal. It asks for one
 * page at a time and stops as soon as a short page arrives (or the optional
 * `total` is reached), so it never holds more than a single page of rows and it
 * issues no further query once the abort signal fires. `maxPages` is a belt-and-
 * braces guard against a repository that ignores the `page` parameter.
 */
export function createRepositorySource({
  repo,
  filters = {},
  chunkSize = DEFAULT_CHUNK_SIZE,
  signal,
  mapRecord,
  maxPages = 100000,
} = {}) {
  if (!repo || typeof repo.findAll !== 'function') {
    throw new TypeError('createRepositorySource requires a repository with findAll');
  }
  const requested = clampChunkSize(chunkSize);
  const map = typeof mapRecord === 'function' ? mapRecord : (record) => record;

  return (async function* iterate() {
    let page = 1;
    while (page <= maxPages) {
      if (isAborted(signal)) return;
      const result = await repo.findAll({ ...filters, page, limit: requested });
      const rows = Array.isArray(result && result.data) ? result.data : [];
      if (!rows.length) return;
      yield rows.map(map);

      const reportedLimit = Number(result.limit);
      const pageSize =
        Number.isFinite(reportedLimit) && reportedLimit > 0
          ? Math.min(reportedLimit, requested)
          : requested;
      const total = Number(result.total);
      if (Number.isFinite(total) && total >= 0) {
        if (page * pageSize >= total) return;
      } else if (rows.length < pageSize) {
        return;
      }
      page += 1;
    }
  })();
}

function clampChunkSize(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_CHUNK_SIZE;
  return Math.min(Math.trunc(parsed), MAX_CHUNK_SIZE);
}
