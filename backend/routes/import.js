// CSV import router (P2-BE2-04).
//
//   POST /api/import/:resource          multipart file OR JSON { csv, mapping, dryRun }
//   GET  /api/import/errors/:reportId   download the generated error CSV
//   POST /api/import/error-report       download by { reportId } (POST-friendly alias)
//   GET  /api/import/preview            header + first rows of an uploaded CSV
//
// The heavy lifting lives in `services/csvImport.js`, which is pure: a dry run
// never calls the persistence callback, so "zero writes during a dry run" is a
// property of the code path rather than an assumption. Error reports are held
// in an in-memory registry (also no writes) so `errorReportId` stays fetchable
// without touching the JSON store.
//
// Registered before the generic `/api/:resource` handlers in server.js. The
// literal `error-report` route is declared before `/:resource` so Express does
// not interpret it as a resource name.

import fs from "node:fs/promises";
import { readDb, mutateDb } from "../store.js";
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
  IMPORT_RESOURCES,
  ImportError,
  parseCsv,
  runImport,
  createErrorReportStore,
} from "../services/csvImport.js";

// Bulk imports are deliberately rate limited, but 5 per 5 minutes blocked
// experimentation. Dry runs are read-only and cheap; the ceiling is set high
// enough for interactive mapping/preview without removing the guard.
const limiter = createRateLimiter({
  windowMs: 300_000,
  max: 60,
  prefix: "import",
});

const errorReports = createErrorReportStore();

const asBoolean = (value) =>
  value === true || value === "true" || value === "1";

function sendErrorReport(res, report) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="import-errors.csv"',
  );
  return res.send(report.csv);
}

export default function registerImportRoutes(app, upload) {
  app.post("/api/import/error-report", auth, (req, res) => {
    const reportId = req.body && req.body.reportId;
    const report = reportId ? errorReports.get(reportId) : null;
    if (!report) {
      return res
        .status(404)
        .json({ error: "Error report not found or expired" });
    }
    return sendErrorReport(res, report);
  });

  app.get("/api/import/errors/:reportId", auth, (req, res) => {
    const report = errorReports.get(req.params.reportId);
    if (!report) {
      return res
        .status(404)
        .json({ error: "Error report not found or expired" });
    }
    return sendErrorReport(res, report);
  });

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
        let csv;
        if (req.file) {
          csv = await fs.readFile(req.file.path, "utf-8");
          await fs.unlink(req.file.path).catch(() => {});
        } else if (typeof body.csv === "string") {
          csv = body.csv;
        } else {
          return res.status(400).json({
            error: "CSV content is required (send `csv` or upload a file)",
          });
        }

        let mapping = body.mapping;
        if (typeof mapping === "string") {
          if (mapping.trim() === "") {
            mapping = undefined;
          } else {
            try {
              mapping = JSON.parse(mapping);
            } catch {
              return res
                .status(400)
                .json({ error: "`mapping` must be valid JSON" });
            }
          }
        }

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

        const persist = async (record) => {
          const repo = repoFor(resource);
          if (!repo) throw new Error(`No repository for resource "${resource}"`);
          const pgData = legacyToPg({ ...record }, resource);
          coerceBuiltIns(resource, pgData);
          return repo.create(pgData);
        };

        const summary = await runImport({
          csv,
          resource,
          schema,
          mapping,
          dryRun,
          failureStrategy,
          persist,
        });

        let errorReportId;
        if (summary.errorCsv) {
          errorReportId = errorReports.save(summary.errorCsv, {
            resource,
            rowCount: summary.errorCount,
          });
        }

        if (!dryRun && summary.importedCount > 0) {
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
            req.user.workspaceId || "default",
          );
        }

        return res.json({
          success: true,
          dryRun,
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
        if (err instanceof ImportError) {
          return res.status(err.status).json({ error: err.message });
        }
        return next(err);
      }
    },
  );

  app.get(
    "/api/import/preview",
    auth,
    upload.single("file"),
    async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ error: "CSV file is required" });
      }
      try {
        const content = await fs.readFile(req.file.path, "utf-8");
        await fs.unlink(req.file.path).catch(() => {});
        const { headers, rows } = parseCsv(content);
        const preview = rows.slice(0, 5).map((row) =>
          Object.fromEntries(headers.map((h, i) => [h, row.values[i] ?? ""])),
        );
        res.json({ headers, preview, totalRows: rows.length });
      } catch (err) {
        if (err instanceof ImportError) {
          return res.status(400).json({ error: err.message });
        }
        res.status(400).json({ error: `Preview failed: ${err.message}` });
      }
    },
  );
}
