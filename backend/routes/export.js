// Streaming export router (P2-BE1-06).
//
//   GET /api/export/:resource?format=csv|json[&columns=a,b,c][&headers=false]
//
// Streams a CRM resource to the client as a CSV or JSON download. The response
// is produced by `services/exportStream.js`, which fetches records in bounded
// batches (Postgres repositories) or bounded array slices (JSON store) and
// pipes each serialized batch straight to the socket under backpressure. At no
// point is the whole result set — or its serialized form — resident in memory.
//
// Registered before the generic `/api/:resource/:id` handlers in server.js:
// without that ordering `/api/export/contacts` would be answered as the record
// `contacts` of the (unknown) `export` resource and 404.
//
// Authentication is the only authorization gate: any signed-in user may export,
// matching the existing `/api/:resource/export.csv` contract.

import { auth } from '../middleware/auth.js';
import { readDb } from '../store.js';
import { resources } from '../helpers.js';
import { buildResourceSchema, listResources } from '../services/schema.js';
import { PG_RESOURCES, pgToLegacy } from '../db/legacy-shape.js';
import { repoFor } from '../db/repositories/index.js';
import { normalizeListQuery, toRepositorySort } from '../middleware/pagination.js';
import { getFieldPermissions, applyFieldMasking } from './permissions.js';
import {
  DEFAULT_CHUNK_SIZE,
  ExportAbortedError,
  createArraySource,
  createRepositorySource,
  exportMetrics,
  streamExport,
} from '../services/exportStream.js';

// A resource is exportable when the generic router, the schema registry or the
// Postgres repository map knows it. Unknown segments answer 404 rather than
// quietly exporting an empty CSV.
const EXPORT_RESOURCES = new Set([
  ...resources,
  ...PG_RESOURCES,
  ...listResources(),
]);

// Same filter vocabulary the generic `/api/:resource` reads (keep in sync with
// PG_FILTER_KEYS in routes/resources.js). Repositories ignore keys they do not
// understand, so this is a superset that only ever narrows a result set.
const PG_FILTER_KEYS = [
  'q',
  'type',
  'status',
  'category',
  'channel',
  'enabled',
  'submitTo',
  'priority',
  'source',
  'audience',
  'survey',
  'respondentEmail',
];

const FORBIDDEN_COLUMNS = new Set(['__proto__', 'constructor', 'prototype']);

const toSnake = (key) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/**
 * column key -> friendly header label, resolved from the reflected schema so a
 * download reads "First Name" rather than "first_name". Registered against the
 * public name, its snake_case form and any documented `mapsTo` column so the
 * label survives the PG/legacy shape difference (schema says `firstName`, the
 * row says `first_name`).
 */
function buildLabelMap(resource, db) {
  const labels = {};
  const schema = buildResourceSchema(resource, { db });
  if (!schema) return labels;
  for (const field of schema.fields) {
    if (!field || !field.name) continue;
    labels[field.name] = field.label || field.name;
    labels[toSnake(field.name)] = field.label || field.name;
    if (field.mapsTo) {
      labels[field.mapsTo] = field.label || field.name;
      labels[toSnake(field.mapsTo)] = field.label || field.name;
    }
  }
  return labels;
}

function parseColumns(raw) {
  if (raw === undefined || raw === null) return null;
  const value = Array.isArray(raw) ? raw.join(',') : String(raw);
  const columns = value
    .split(',')
    .map((column) => column.trim())
    .filter(Boolean);
  return columns.length ? columns : null;
}

function truthyFlag(value) {
  return value === true || value === 'true' || value === '1';
}

export default function registerExportRoutes(app) {
  app.get('/api/export/:resource', auth, async (req, res, next) => {
    const resource = req.params.resource;

    if (!EXPORT_RESOURCES.has(resource)) {
      return res.status(404).json({
        error: `Unknown export resource "${resource}".`,
      });
    }

    const format = String(req.query.format || 'csv').toLowerCase();
    if (format !== 'csv' && format !== 'json') {
      return res.status(400).json({ error: 'format must be "csv" or "json"' });
    }

    const requestedColumns = parseColumns(req.query.columns);
    if (requestedColumns && requestedColumns.some((column) => FORBIDDEN_COLUMNS.has(column))) {
      return res.status(400).json({ error: 'Invalid column selection' });
    }

    // `headers=false` drops the CSV header row (used by machine readers that
    // already know the schema); JSON is unaffected.
    const includeHeader = req.query.headers === undefined
      ? true
      : truthyFlag(req.query.headers);

    // Abort the source the instant the client goes away. Both the request and
    // response emit `close`; the `writableEnded` guard keeps a normal completion
    // from being mistaken for a disconnect.
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.on('close', onClose);
    res.on('close', onClose);

    let source;
    let labels = {};
    try {
      const db = await readDb();
      labels = buildLabelMap(resource, db);
      const fieldPerms = getFieldPermissions(
        db,
        resource.replace(/s$/, ''),
        req.user.role,
      );
      const mask = (record) =>
        fieldPerms ? applyFieldMasking(record, fieldPerms) : record;

      if (PG_RESOURCES.has(resource)) {
        const repo = repoFor(resource);
        if (!repo) {
          return res
            .status(404)
            .json({ error: `No export source for "${resource}".` });
        }
        const filters = {};
        for (const key of PG_FILTER_KEYS) {
          if (req.query[key] !== undefined && req.query[key] !== '') {
            filters[key] = req.query[key];
          }
        }
        const { sortBy, sortDir } = normalizeListQuery(req.query);
        filters.sortBy = toRepositorySort(sortBy, sortDir);

        source = createRepositorySource({
          repo,
          filters,
          chunkSize: DEFAULT_CHUNK_SIZE,
          signal: controller.signal,
          mapRecord: (row) => mask(pgToLegacy(row, resource)),
        });
      } else {
        const records = Array.isArray(db[resource]) ? db[resource] : [];
        source = createArraySource(records, {
          chunkSize: DEFAULT_CHUNK_SIZE,
          signal: controller.signal,
          mapRecord: mask,
        });
      }
    } catch (error) {
      req.off('close', onClose);
      res.off('close', onClose);
      return next(error);
    }

    const extension = format === 'json' ? 'json' : 'csv';
    res.setHeader(
      'Content-Type',
      format === 'json'
        ? 'application/json; charset=utf-8'
        : 'text/csv; charset=utf-8',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${resource}-export.${extension}"`,
    );
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    // Streaming responses must not be buffered by an intermediary; the header is
    // advisory for nginx-style proxies that would otherwise collect the body.
    res.setHeader('X-Accel-Buffering', 'no');
    if (!res.getHeader('Transfer-Encoding')) {
      res.setHeader('Transfer-Encoding', 'chunked');
    }

    exportMetrics.requests += 1;
    try {
      const result = await streamExport({
        res,
        source,
        format,
        columns: requestedColumns,
        labels,
        headers: includeHeader,
        signal: controller.signal,
      });
      exportMetrics.rowsStreamed += result.rowCount;
      if (result.aborted) exportMetrics.aborted += 1;
      else exportMetrics.completed += 1;
    } catch (error) {
      if (error instanceof ExportAbortedError) {
        exportMetrics.aborted += 1;
      } else if (!res.headersSent) {
        return next(error);
      } else {
        // Headers are already on the wire; the only honest signal left is to
        // tear the connection down so the client does not accept a truncated
        // body as a complete file.
        res.destroy(error);
      }
    } finally {
      req.off('close', onClose);
      res.off('close', onClose);
    }
  });
}
