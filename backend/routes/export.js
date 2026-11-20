import { auth } from "../middleware/auth.js";
import { readDb } from "../store.js";
import { resources } from "../helpers.js";
import { buildResourceSchema, listResources } from "../services/schema.js";
import { PG_RESOURCES, pgToLegacy } from "../db/legacy-shape.js";
import { repoFor } from "../db/repositories/index.js";
import { normalizeListQuery } from "../middleware/pagination.js";
import {
  getFieldPermissions,
  normalizeFieldKey,
  objectTypeOf,
} from "./permissions.js";
import { createRateLimiter } from "../services/rateLimit.js";
import {
  DEFAULT_CHUNK_SIZE,
  ExportAbortedError,
  createArraySource,
  createRepositorySource,
  exportMetrics,
  streamExport,
} from "../services/exportStream.js";

const limiter = createRateLimiter({
  windowMs: 60_000,
  max: 30,
  prefix: "export",
});

const EXPORT_RESOURCES = new Set([
  ...resources,
  ...PG_RESOURCES,
  ...listResources(),
]);

const PG_FILTER_KEYS = [
  "q",
  "type",
  "contact",
  "recordId",
  "stage",
  "status",
  "category",
  "channel",
  "enabled",
  "submitTo",
  "priority",
  "source",
  "audience",
  "survey",
  "respondentEmail",
];

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const FORBIDDEN_COLUMNS = new Set(["__proto__", "constructor", "prototype"]);

const tenantOf = (req) =>
  req.user?.workspaceId || req.user?.workspace_id || "default";

const toSnake = (key) =>
  String(key).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

const PG_SORT_ALIASES = {
  createdAt: "created_at",
  updatedAt: "updated_at",
};

function pgSortBy(sortBy, sortDir) {
  const column = PG_SORT_ALIASES[sortBy] || sortBy || "created_at";
  const direction = String(sortDir || "desc").toLowerCase() === "asc" ? "asc" : "desc";
  return `${column}:${direction}`;
}

function parseColumns(raw) {
  if (raw === undefined || raw === null) return null;
  const value = Array.isArray(raw) ? raw.join(",") : String(raw);
  const columns = value
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean);
  return columns.length ? columns : null;
}

function truthyFlag(value) {
  return value === true || value === "true" || value === "1";
}

function sanitizeFilenameSegment(value) {
  const cleaned = String(value || "export").replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "export";
}

function tenantMatches(record, tenantId) {
  if (!record || typeof record !== "object") return false;
  const recordTenant = record.workspaceId ?? record.workspace_id;
  if (recordTenant === undefined || recordTenant === null) {
    return tenantId === "default";
  }
  return String(recordTenant) === String(tenantId);
}

function buildLabelMap(resource, db) {
  const labels = {};
  const schema = buildResourceSchema(resource, { db });
  if (!schema) return labels;
  for (const field of schema.fields || []) {
    if (!field || !field.name) continue;
    const label = field.label || field.name;
    labels[field.name] = label;
    labels[toSnake(field.name)] = label;
    if (field.mapsTo) {
      labels[field.mapsTo] = label;
      labels[toSnake(field.mapsTo)] = label;
    }
  }
  return labels;
}

function collectSchemaColumnNames(schema) {
  const names = new Set();
  if (!schema) return names;
  for (const field of schema.fields || []) {
    if (!field || !field.name) continue;
    names.add(field.name);
    names.add(toSnake(field.name));
    if (field.mapsTo) {
      names.add(field.mapsTo);
      names.add(toSnake(field.mapsTo));
    }
  }
  return names;
}

function normalizedHiddenSet(fieldPerms) {
  const hidden = fieldPerms?.hiddenFields;
  if (!Array.isArray(hidden)) return new Set();
  return new Set(hidden.map(normalizeFieldKey).filter(Boolean));
}

function isMaskedColumn(column, hiddenNorm) {
  if (!hiddenNorm || hiddenNorm.size === 0) return false;
  const norm = normalizeFieldKey(column);
  return hiddenNorm.has(norm) || hiddenNorm.has(toSnake(column));
}

function stripMaskedFields(record, hiddenNorm) {
  if (!record || typeof record !== "object") return record;
  if (!hiddenNorm || hiddenNorm.size === 0) return record;
  const out = Array.isArray(record) ? [...record] : { ...record };

  for (const key of Object.keys(out)) {
    const norm = normalizeFieldKey(key);
    if (hiddenNorm.has(norm)) {
      delete out[key];
      continue;
    }
    const value = out[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      let changed = false;
      const nested = { ...value };
      for (const nestedKey of Object.keys(nested)) {
        if (hiddenNorm.has(normalizeFieldKey(nestedKey))) {
          delete nested[nestedKey];
          changed = true;
        }
      }
      if (changed) out[key] = nested;
    }
  }
  return out;
}

function validateRequestedColumns(requestedColumns, schema, hiddenNorm) {
  if (!requestedColumns) return { ok: true, columns: null };
  const schemaNames = collectSchemaColumnNames(schema);

  const masked = [];
  const unknown = [];
  for (const column of requestedColumns) {
    if (FORBIDDEN_COLUMNS.has(column)) {
      unknown.push(column);
      continue;
    }
    if (isMaskedColumn(column, hiddenNorm)) {
      masked.push(column);
      continue;
    }
    const normalized = normalizeFieldKey(column);
    let known = false;
    if (schemaNames.size > 0) {
      for (const name of schemaNames) {
        if (normalizeFieldKey(name) === normalized) {
          known = true;
          break;
        }
      }
    } else {
      known = true;
    }
    if (!known) unknown.push(column);
  }

  if (masked.length > 0) {
    return { ok: false, status: 403, error: "Forbidden: Cannot export masked field(s)", maskedFields: masked };
  }
  if (unknown.length > 0) {
    return { ok: false, status: 400, error: `Unknown column(s): ${unknown.join(", ")}` };
  }
  return { ok: true, columns: requestedColumns.slice() };
}

export default function registerExportRoutes(app) {
  app.get("/api/export/:resource", auth, limiter, async (req, res, next) => {
    const resource = String(req.params.resource || "");

    if (FORBIDDEN_SEGMENTS.has(resource) || !EXPORT_RESOURCES.has(resource)) {
      return res.status(404).json({
        error: `Unknown export resource "${resource}".`,
      });
    }

    const format = String(req.query.format || "csv").toLowerCase();
    if (format !== "csv" && format !== "json") {
      return res.status(400).json({ error: 'format must be "csv" or "json"' });
    }

    const requestedColumns = parseColumns(req.query.columns);
    if (requestedColumns && requestedColumns.some((column) => FORBIDDEN_COLUMNS.has(column))) {
      return res.status(400).json({ error: "Invalid column selection" });
    }

    const includeHeader =
      req.query.headers === undefined ? true : truthyFlag(req.query.headers);

    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.on("close", onClose);
    res.on("close", onClose);

    let source;
    let labels = {};
    let columnsForExport = null;
    try {
      const db = await readDb();
      const workspaceId = tenantOf(req);
      const schema = buildResourceSchema(resource, { db });
      labels = buildLabelMap(resource, db);

      const objectType = objectTypeOf(resource);
      const fieldPerms = getFieldPermissions(db, objectType, req.user.role);
      const hiddenNorm = normalizedHiddenSet(fieldPerms);

      const validated = validateRequestedColumns(requestedColumns, schema, hiddenNorm);
      if (!validated.ok) {
        req.off("close", onClose);
        res.off("close", onClose);
        const body = { error: validated.error };
        if (validated.maskedFields) body.maskedFields = validated.maskedFields;
        return res.status(validated.status).json(body);
      }
      columnsForExport = validated.columns;

      const mapRecord = (record) => stripMaskedFields(record, hiddenNorm);

      if (PG_RESOURCES.has(resource)) {
        const repo = repoFor(resource);
        if (!repo || typeof repo.findAll !== "function") {
          req.off("close", onClose);
          res.off("close", onClose);
          return res
            .status(404)
            .json({ error: `No export source for "${resource}".` });
        }

        const filters = { workspaceId };
        for (const key of PG_FILTER_KEYS) {
          if (req.query[key] !== undefined && req.query[key] !== "") {
            filters[key] = req.query[key];
          }
        }
        const { sortBy, sortDir } = normalizeListQuery(req.query);
        filters.sortBy = pgSortBy(sortBy, sortDir);

        source = createRepositorySource({
          repo,
          filters,
          chunkSize: DEFAULT_CHUNK_SIZE,
          signal: controller.signal,
          mapRecord: (row) => mapRecord(pgToLegacy(row, resource)),
        });
      } else {
        const all = Array.isArray(db[resource]) ? db[resource] : [];
        const records = all.filter((row) => tenantMatches(row, workspaceId));
        source = createArraySource(records, {
          chunkSize: DEFAULT_CHUNK_SIZE,
          signal: controller.signal,
          mapRecord,
        });
      }
    } catch (error) {
      req.off("close", onClose);
      res.off("close", onClose);
      return next(error);
    }

    const extension = format === "json" ? "json" : "csv";
    res.setHeader(
      "Content-Type",
      format === "json"
        ? "application/json; charset=utf-8"
        : "text/csv; charset=utf-8",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${sanitizeFilenameSegment(resource)}-export.${extension}"`,
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    if (!res.getHeader("Transfer-Encoding")) {
      res.setHeader("Transfer-Encoding", "chunked");
    }

    exportMetrics.requests += 1;
    try {
      const result = await streamExport({
        res,
        source,
        format,
        columns: columnsForExport,
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
        res.destroy(error);
      }
    } finally {
      req.off("close", onClose);
      res.off("close", onClose);
    }
  });
}
