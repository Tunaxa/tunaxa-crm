export const DEFAULT_CHUNK_SIZE = 500;
export const MAX_CHUNK_SIZE = 5000;

export class ExportAbortedError extends Error {
  constructor(message = "Export aborted: client disconnected") {
    super(message);
    this.name = "ExportAbortedError";
    this.code = "EXPORT_ABORTED";
  }
}

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

export function humanizeKey(key) {
  return String(key)
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function escapeCsvValue(value) {
  if (value === null || value === undefined) return "";
  const text =
    typeof value === "object" ? JSON.stringify(value) : String(value);
  if (text === "") return "";
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function serializeCsvRow(record, columns) {
  return columns.map((column) => escapeCsvValue(record?.[column])).join(",");
}

export function serializeCsvBatch(records, columns) {
  let out = "";
  for (const record of records) {
    out += `${serializeCsvRow(record, columns)}\r\n`;
  }
  return out;
}

export function serializeCsvHeader(columns, labels) {
  return columns
    .map((column) => {
      const label =
        labels && typeof labels === "object" && labels[column]
          ? labels[column]
          : humanizeKey(column);
      return escapeCsvValue(label);
    })
    .join(",");
}

export function serializeJsonBatch(records, state) {
  let out = "";
  for (const record of records) {
    out += `${state.first ? "" : ","}${JSON.stringify(record ?? null)}`;
    state.first = false;
  }
  return out;
}

export function resolveColumns(records, explicit) {
  if (Array.isArray(explicit) && explicit.length) return explicit.slice();
  const columns = [];
  const seen = new Set();
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    for (const key of Object.keys(record)) {
      if (key === "__proto__" || seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  return columns;
}

export function writeChunk(res, chunk, signal) {
  return new Promise((resolve, reject) => {
    if (isAborted(signal) || res.writableEnded || res.destroyed) {
      reject(new ExportAbortedError());
      return;
    }

    let settled = false;
    const onDrain = () => finish();
    const onClose = () => finish(new ExportAbortedError());
    const onError = (error) => finish(error);
    const onAbort = () => finish(new ExportAbortedError());

    function cleanup() {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
    }

    function finish(error) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    }

    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
    if (signal && typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", onAbort, { once: true });
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

export async function streamExport(options) {
  const {
    res,
    source: rawSource,
    format = "csv",
    columns: explicitColumns = null,
    labels = null,
    headers = true,
    signal,
    onBatch,
  } = options || {};

  const normalizedFormat = format === "json" ? "json" : "csv";
  const source =
    rawSource && typeof rawSource[Symbol.asyncIterator] === "function"
      ? rawSource
      : rawSource && typeof rawSource[Symbol.iterator] === "function"
        ? rawSource
        : typeof rawSource === "function"
          ? rawSource()
          : null;

  if (!source) throw new TypeError("streamExport requires an iterable source");
  if (!res || typeof res.write !== "function") {
    throw new TypeError("streamExport requires a writable response");
  }

  let columns =
    Array.isArray(explicitColumns) && explicitColumns.length
      ? explicitColumns.slice()
      : null;
  let wroteHeader = false;
  let rowCount = 0;
  const jsonState = { first: true };

  try {
    if (normalizedFormat === "json") {
      await writeChunk(res, "[", signal);
    }

    for await (const batch of source) {
      if (isAborted(signal)) throw new ExportAbortedError();
      const records = Array.isArray(batch) ? batch : batch == null ? [] : [batch];
      if (!records.length) continue;

      if (normalizedFormat === "csv") {
        if (!columns) columns = resolveColumns(records, explicitColumns);
        if (!wroteHeader && headers) {
          await writeChunk(
            res,
            `${serializeCsvHeader(columns, labels)}\r\n`,
            signal,
          );
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
      if (typeof onBatch === "function") onBatch(rowCount);
    }

    if (isAborted(signal)) throw new ExportAbortedError();

    if (normalizedFormat === "csv" && headers && !wroteHeader) {
      columns = columns || resolveColumns([], explicitColumns);
      if (columns.length) {
        await writeChunk(
          res,
          `${serializeCsvHeader(columns, labels)}\r\n`,
          signal,
        );
      }
    }

    if (normalizedFormat === "json") {
      await writeChunk(res, "]", signal);
    }

    if (!res.writableEnded && !res.destroyed) res.end();
    return {
      format: normalizedFormat,
      rowCount,
      columns: columns || [],
      aborted: false,
    };
  } catch (error) {
    if (error instanceof ExportAbortedError) {
      if (!res.destroyed && !res.writableEnded) {
        try {
          res.end();
        } catch {
          void 0;
        }
      }
      return {
        format: normalizedFormat,
        rowCount,
        columns: columns || [],
        aborted: true,
      };
    }
    throw error;
  }
}

export function createArraySource(
  records,
  { chunkSize = DEFAULT_CHUNK_SIZE, signal, mapRecord } = {},
) {
  const list = Array.isArray(records) ? records : [];
  const size = clampChunkSize(chunkSize);
  const map = typeof mapRecord === "function" ? mapRecord : (record) => record;

  return (async function* iterate() {
    for (let index = 0; index < list.length; index += size) {
      if (isAborted(signal)) return;
      yield list.slice(index, index + size).map(map);
    }
  })();
}

export function createRepositorySource({
  repo,
  filters = {},
  chunkSize = DEFAULT_CHUNK_SIZE,
  signal,
  mapRecord,
  maxPages = 100000,
} = {}) {
  if (!repo || typeof repo.findAll !== "function") {
    throw new TypeError(
      "createRepositorySource requires a repository with findAll",
    );
  }
  const requested = clampChunkSize(chunkSize);
  const map = typeof mapRecord === "function" ? mapRecord : (record) => record;

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
