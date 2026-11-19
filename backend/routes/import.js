// CSV import router (P2-BE2-04).
//
//   POST /api/import/:resource          multipart file OR JSON { csv, mapping, dryRun, failureStrategy }
//   GET|POST /api/import/preview        header + first rows (multipart file or JSON { csv })
//   GET  /api/import/errors/:reportId   download the generated error CSV (tenant-scoped)
//   POST /api/import/error-report       download by { reportId } (POST-friendly alias)
//
// The heavy lifting lives in `services/csvImport.js`, which is pure: a dry run
// never calls the persistence callback, so "zero writes during a dry run" is a
// property of the code path rather than an assumption. Error reports are held
// in an in-memory registry (also no writes) and are scoped to the requesting
// tenant.

import fs from "node:fs/promises";
import { readDb, mutateDb } from "../store.js";
import { query } from "../db/pg.js";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { auditEntry, coerceBuiltIns } from "../helpers.js";
import { createRateLimiter } from "../services/rateLimit.js";
import { broadcast } from "./sse.js";
import { cacheFlush } from "../services/cache.js";
import { buildResourceSchema } from "../services/schema.js";
import { repoFor } from "../db/repositories/index.js";
import { legacyToPg } from "../db/legacy-shape.js";
import {
  getFieldPermissions,
  objectTypeOf,
  validateWriteFieldPermissions,
} from "./permissions.js";
import {
  IMPORT_RESOURCES,
  ImportError,
  parseCsv,
  runImport,
  createErrorReportStore,
  buildDefaultMapping,
  resolveMapping,
  mapRow,
  validateRecord,
} from "../services/csvImport.js";

const limiter = createRateLimiter({
  windowMs: 300_000,
  max: 60,
  prefix: "import",
});

const errorReports = createErrorReportStore();
const REPORT_ID_RE = /^[A-Za-z0-9_-]+$/;

const asBoolean = (value) =>
  value === true || value === "true" || value === "1";

function tenantOf(req) {
  return req.user?.workspaceId || req.user?.workspace_id || "default";
}

function sendErrorReport(res, report) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="import-errors.csv"',
  );
  return res.send(report.csv);
}

function safeReport(req, reportId) {
  if (typeof reportId !== "string" || !REPORT_ID_RE.test(reportId)) return null;
  const report = errorReports.get(reportId);
  if (!report) return null;
  if (report.workspaceId !== tenantOf(req)) return null;
  return report;
}

async function readCsvInput(req) {
  if (req.file) {
    const csv = await fs.readFile(req.file.path, "utf-8");
    await fs.unlink(req.file.path).catch(() => {});
    return csv;
  }
  const body = req.body || {};
  if (typeof body.csv === "string") return body.csv;
  return null;
}

function parseMapping(body) {
  let mapping = body?.mapping;
  if (typeof mapping === "string") {
    if (mapping.trim() === "") return undefined;
    try {
      return JSON.parse(mapping);
    } catch {
      throw new ImportError("`mapping` must be valid JSON");
    }
  }
  return mapping;
}

function stripTenantOverrides(record) {
  if (!record || typeof record !== "object") return record;
  delete record.workspaceId;
  delete record.workspace_id;
  return record;
}

async function checkFieldMasks({ req, db, resource, records }) {
  if (!Array.isArray(records) || records.length === 0) return null;
  const objectType = objectTypeOf(resource);
  const fieldPerms = getFieldPermissions(db, objectType, req.user.role);
  const violations = new Set();
  for (const record of records) {
    const check = await validateWriteFieldPermissions({
      user: req.user,
      resource: objectType,
      data: record,
      fieldPerms,
      db,
      action: req.method,
    });
    if (!check.allowed) {
      for (const field of check.maskedFields || []) violations.add(field);
    }
  }
  if (violations.size === 0) return null;
  return {
    error: "Forbidden: Cannot write to masked field(s)",
    maskedFields: [...violations].sort(),
  };
}

const PIPELINE_FALLBACK_CODES = new Set([
  "42P01",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "3D000",
  "28P01",
]);

async function listPipelineDefinitions(tenant) {
  try {
    const { rows } = await query(
      "SELECT id, workspace_id, name, entity_type, is_default, stages, created_by, created_at, updated_at FROM pipeline_definitions WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC",
      [tenant],
    );
    return rows.map((row) => {
      let stages = [];
      try {
        const raw = row.stages;
        stages = Array.isArray(raw) ? raw : JSON.parse(String(raw || "[]"));
      } catch {
        stages = [];
      }
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        name: row.name,
        entityType: row.entity_type || "deal",
        isDefault: Boolean(row.is_default),
        stages: Array.isArray(stages) ? stages : [],
      };
    });
  } catch (error) {
    if (!PIPELINE_FALLBACK_CODES.has(error?.code)) throw error;
  }
  const db = await readDb();
  return (Array.isArray(db.pipelineDefinitions) ? db.pipelineDefinitions : [])
    .filter((p) => p && p.workspaceId === tenant)
    .map((p) => ({
      id: p.id,
      workspaceId: p.workspaceId,
      name: p.name,
      entityType: p.entityType || "deal",
      isDefault: Boolean(p.isDefault),
      stages: Array.isArray(p.stages) ? p.stages : [],
    }));
}

function defaultDealPipelineId(defs) {
  const fallback =
    defs.find((d) => d.isDefault && d.entityType === "deal") ||
    defs.find((d) => d.entityType === "deal") ||
    defs[0];
  return fallback?.id || null;
}

async function validateDealRecords(records, req) {
  if (!Array.isArray(records) || records.length === 0) {
    return { failure: null, defaultPipelineId: null };
  }
  const tenant = tenantOf(req);
  const defs = await listPipelineDefinitions(tenant);
  const byId = new Map(defs.map((d) => [d.id, d]));
  const fallbackId = defaultDealPipelineId(defs);

  for (const record of records) {
    stripTenantOverrides(record);
    const supplied = record.pipelineId;
    if (supplied === undefined || supplied === null || supplied === "") {
      if (fallbackId) record.pipelineId = fallbackId;
      continue;
    }
    if (typeof supplied !== "string") {
      return {
        failure: {
          status: 400,
          body: { error: "pipelineId must be a string" },
        },
        defaultPipelineId: fallbackId,
      };
    }
    const match = byId.get(supplied);
    if (!match || match.workspaceId !== tenant) {
      return {
        failure: { status: 404, body: { error: "Pipeline not found" } },
        defaultPipelineId: fallbackId,
      };
    }
  }
  return { failure: null, defaultPipelineId: fallbackId };
}

export default function registerImportRoutes(app, upload) {
  // Literal routes first so "/:resource" never shadows them.
  app.get(
    "/api/import/preview",
    auth,
    requireRole("admin", "member"),
    limiter,
    upload.single("file"),
    handlePreview,
  );

  app.post(
    "/api/import/preview",
    auth,
    requireRole("admin", "member"),
    limiter,
    upload.single("file"),
    handlePreview,
  );

  app.get(
    "/api/import/errors/:reportId",
    auth,
    requireRole("admin", "member"),
    (req, res) => {
      const report = safeReport(req, req.params.reportId);
      if (!report) {
        return res
          .status(404)
          .json({ error: "Error report not found or expired" });
      }
      return sendErrorReport(res, report);
    },
  );

  app.post(
    "/api/import/error-report",
    auth,
    requireRole("admin", "member"),
    (req, res) => {
      const report = safeReport(req, req.body?.reportId);
      if (!report) {
        return res
          .status(404)
          .json({ error: "Error report not found or expired" });
      }
      return sendErrorReport(res, report);
    },
  );

  app.post(
    "/api/import/:resource",
    auth,
    requireRole("admin", "member"),
    limiter,
    upload.single("file"),
    async (req, res, next) => {
      const resource = req.params.resource;
      if (!IMPORT_RESOURCES.includes(resource)) {
        return res.status(400).json({
          error: `Resource must be one of: ${IMPORT_RESOURCES.join(", ")}`,
        });
      }

      const body = req.body || {};
      try {
        const csv = await readCsvInput(req);
        if (typeof csv !== "string") {
          return res.status(400).json({
            error: "CSV content is required (send `csv` or upload a file)",
          });
        }

        const mapping = parseMapping(body);
        const dryRun = asBoolean(body.dryRun);
        const failureStrategy =
          body.failureStrategy === "abort" ? "abort" : "continue";

        const db = await readDb();
        const schema = buildResourceSchema(resource, { db });
        if (!schema) {
          return res
            .status(400)
            .json({ error: `Schema for "${resource}" is unavailable` });
        }

        // Parse/map once for security checks (field masks, tenant overrides,
        // deal pipeline rules) on the effective records. Dry-run execution
        // below remains the source for user-visible metrics.
        const { headers, rows } = parseCsv(csv);
        if (headers.length === 0)
          throw new ImportError("CSV must include a header row");
        if (rows.length === 0)
          throw new ImportError("No data rows found in CSV");
        if (rows.length > 1000) {
          throw new ImportError("Maximum 1000 rows per import");
        }
        if (Buffer.byteLength(csv, "utf8") > 5 * 1024 * 1024) {
          throw new ImportError(
            "CSV payload exceeds the 5 MB limit",
            413,
          );
        }

        const assignments = resolveMapping(mapping, headers, schema);
        if (assignments.length === 0) {
          throw new ImportError(
            "No CSV columns could be mapped to fields; provide an explicit `mapping`",
          );
        }

        const validRecords = [];
        for (const row of rows) {
          const record = stripTenantOverrides(mapRow(row, assignments));
          const rowErrors = validateRecord(record, schema, resource);
          if (row.values.length !== headers.length) {
            rowErrors.unshift("column-count-mismatch");
          }
          if (rowErrors.length === 0) validRecords.push(record);
        }

        const maskFailure = await checkFieldMasks({
          req,
          db,
          resource,
          records: validRecords,
        });
        if (maskFailure) {
          return res.status(403).json(maskFailure);
        }

        let defaultPipelineId = null;
        if (resource === "deals") {
          // Reject invalid/cross-tenant pipeline IDs even when rows have other
          // schema errors, so imports never accept a foreign/unknown pipeline.
          const tenant = tenantOf(req);
          const defs = await listPipelineDefinitions(tenant);
          const byId = new Map(defs.map((d) => [d.id, d]));
          defaultPipelineId = defaultDealPipelineId(defs);
          for (const row of rows) {
            const mapped = stripTenantOverrides(mapRow(row, assignments));
            const supplied = mapped.pipelineId;
            if (supplied === undefined || supplied === null || supplied === "") continue;
            if (typeof supplied !== "string") {
              return res.status(400).json({ error: "pipelineId must be a string" });
            }
            const match = byId.get(supplied);
            if (!match || match.workspaceId !== tenant) {
              return res.status(404).json({ error: "Pipeline not found" });
            }
          }

          const dealCheck = await validateDealRecords(validRecords, req);
          if (dealCheck.failure) {
            return res.status(dealCheck.failure.status).json(dealCheck.failure.body);
          }
          // keep computed default (in case validateDealRecords recalculated consistently)
          defaultPipelineId = dealCheck.defaultPipelineId || defaultPipelineId;
        }

        if (dryRun) {
          const probe = await runImport({
            csv,
            resource,
            schema,
            mapping,
            dryRun: true,
          });
          let errorReportId;
          if (probe.errorCsv) {
            errorReportId = errorReports.save(probe.errorCsv, {
              resource,
              workspaceId: tenantOf(req),
              rowCount: probe.errorCount,
            });
          }
          return res.json({
            success: true,
            dryRun: true,
            resource,
            totalRows: probe.totalRows,
            validRows: probe.validRows,
            invalidRows: probe.invalidRows,
            importedCount: 0,
            errorCount: probe.errorCount,
            errors: probe.errors,
            errorReportId,
            errorCsv: probe.errorCsv || undefined,
          });
        }

        const workspaceId = tenantOf(req);
        const persist = async (record) => {
          stripTenantOverrides(record);
          if (
            resource === "deals" &&
            (record.pipelineId === undefined ||
              record.pipelineId === null ||
              record.pipelineId === "") &&
            defaultPipelineId
          ) {
            record.pipelineId = defaultPipelineId;
          }
          const repo = repoFor(resource);
          if (!repo)
            throw new Error(`No repository for resource "${resource}"`);
          const pgData = legacyToPg({ ...record }, resource);
          pgData.workspace_id = workspaceId;
          coerceBuiltIns(resource, pgData);
          return repo.create(pgData);
        };

        const summary = await runImport({
          csv,
          resource,
          schema,
          mapping,
          dryRun: false,
          failureStrategy,
          persist,
        });

        let errorReportId;
        if (summary.errorCsv) {
          errorReportId = errorReports.save(summary.errorCsv, {
            resource,
            workspaceId,
            rowCount: summary.errorCount,
          });
        }

        if (summary.importedCount > 0) {
          await mutateDb((database) => {
            database.audit.unshift(
              auditEntry({
                action: `Imported ${summary.importedCount} ${resource} from CSV`,
                actor: req.user.name,
                req,
              }),
            );
          });
          cacheFlush(resource);
          broadcast(
            "import.completed",
            { resource, count: summary.importedCount },
            workspaceId,
          );
        }

        return res.json({
          success: true,
          dryRun: false,
          resource,
          totalRows: summary.totalRows,
          validRows: summary.validRows,
          invalidRows: summary.invalidRows,
          importedCount: summary.importedCount,
          errorCount: summary.errorCount,
          errors: summary.errors,
          errorReportId,
          errorCsv: summary.errorCsv || undefined,
        });
      } catch (err) {
        if (req.file?.path) {
          await fs.unlink(req.file.path).catch(() => {});
        }
        if (err instanceof ImportError) {
          return res.status(err.status).json({ error: err.message });
        }
        return next(err);
      }
    },
  );
}

async function handlePreview(req, res) {
  try {
    const csv = await readCsvInput(req);
    if (typeof csv !== "string") {
      return res.status(400).json({
        error: "CSV content is required (send `csv` or upload a file)",
      });
    }
    if (Buffer.byteLength(csv, "utf8") > 5 * 1024 * 1024) {
      return res
        .status(413)
        .json({ error: "CSV payload exceeds the 5 MB limit" });
    }
    const { headers, rows } = parseCsv(csv);
    const preview = rows.slice(0, 5).map((row) =>
      Object.fromEntries(headers.map((h, i) => [h, row.values[i] ?? ""])),
    );
    let defaultMapping;
    const resource = req.query?.resource || req.body?.resource;
    if (
      typeof resource === "string" &&
      IMPORT_RESOURCES.includes(resource)
    ) {
      try {
        const db = await readDb();
        const schema = buildResourceSchema(resource, { db });
        if (schema) defaultMapping = buildDefaultMapping(headers, schema);
      } catch {
        // preview should still succeed without schema hints
      }
    }
    return res.json({
      headers,
      preview,
      rows: preview,
      totalRows: rows.length,
      ...(defaultMapping ? { defaultMapping } : {}),
    });
  } catch (err) {
    if (req.file?.path) {
      await fs.unlink(req.file.path).catch(() => {});
    }
    if (err instanceof ImportError) {
      return res.status(err.status).json({ error: err.message });
    }
    return res.status(400).json({ error: `Preview failed: ${err.message}` });
  }
}
