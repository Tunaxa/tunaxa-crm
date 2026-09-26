import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mutateDb } from "../store.js";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { id, now } from "../helpers.js";
import { createRateLimiter } from "../services/rateLimit.js";
import { broadcast } from "./sse.js";

const root = path.dirname(fileURLToPath(import.meta.url));
void root;
const limiter = createRateLimiter({
  windowMs: 300_000,
  max: 5,
  prefix: "import",
});

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0]
    .split(",")
    .map((h) => h.trim().replace(/^"|"$/g, "").toLowerCase());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i]
      .split(",")
      .map((v) => v.trim().replace(/^"|"$/g, ""));
    if (values.length === headers.length) {
      const row = {};
      headers.forEach((h, idx) => {
        row[h] = values[idx];
      });
      rows.push(row);
    }
  }
  return { headers, rows };
}

function mapFields(row, resource) {
  const fieldMap = {
    leads: {
      name: ["name", "lead name", "full name"],
      email: ["email", "e-mail"],
      phone: ["phone", "telephone", "mobile"],
      company: ["company", "organization"],
      source: ["source", "lead source"],
      status: ["status", "lead status"],
    },
    contacts: {
      name: ["name", "full name", "contact name"],
      email: ["email", "e-mail"],
      phone: ["phone", "telephone", "mobile"],
      company: ["company", "organization"],
    },
    companies: {
      name: ["name", "company", "organization"],
      industry: ["industry", "sector"],
      country: ["country", "location"],
    },
    deals: {
      title: ["title", "deal name", "name"],
      value: ["value", "amount", "deal value"],
      stage: ["stage", "pipeline stage"],
      company: ["company"],
    },
  };
  const map = fieldMap[resource] || {};
  const mapped = {};
  for (const [field, aliases] of Object.entries(map)) {
    for (const alias of aliases) {
      if (row[alias] !== undefined && row[alias] !== "") {
        mapped[field] = row[alias];
        break;
      }
    }
  }
  return mapped;
}

export default function registerImportRoutes(app, upload) {
  app.post(
    "/api/import/:resource",
    auth,
    requireRole("admin", "member"),
    limiter,
    upload.single("file"),
    async (req, res) => {
      if (!req.file)
        return res.status(400).json({ error: "CSV file is required" });
      const resource = req.params.resource;
      const validResources = ["leads", "contacts", "companies", "deals"];
      if (!validResources.includes(resource))
        return res
          .status(400)
          .json({
            error: `Resource must be one of: ${validResources.join(", ")}`,
          });

      try {
        const content = await fs.readFile(req.file.path, "utf-8");
        await fs.unlink(req.file.path).catch(() => {});
        const { headers, rows } = parseCSV(content);
        if (rows.length === 0)
          return res.status(400).json({ error: "No data rows found in CSV" });
        if (rows.length > 1000)
          return res
            .status(400)
            .json({ error: "Maximum 1000 rows per import" });

        const mapped = rows
          .map((row) => mapFields(row, resource))
          .filter((r) => Object.keys(r).length > 0);
        const createdAt = now();
        let imported = 0;
        await mutateDb((db) => {
          for (const data of mapped) {
            const record = {
              id: id(resource.slice(0, -1) || "item"),
              ...data,
              createdAt,
              updatedAt: createdAt,
            };
            db[resource].unshift(record);
            imported++;
          }
          db.audit.unshift({
            id: id("audit"),
            action: `Imported ${imported} ${resource} from CSV`,
            actor: req.user.name,
            createdAt,
          });
        });

        broadcast("import.completed", { resource, count: imported, headers });
        res.status(201).json({ imported, headers, total: rows.length });
      } catch (err) {
        res.status(400).json({ error: `Import failed: ${err.message}` });
      }
    },
  );

  app.get(
    "/api/import/preview",
    auth,
    upload.single("file"),
    async (req, res) => {
      if (!req.file)
        return res.status(400).json({ error: "CSV file is required" });
      try {
        const content = await fs.readFile(req.file.path, "utf-8");
        await fs.unlink(req.file.path).catch(() => {});
        const { headers, rows } = parseCSV(content);
        res.json({
          headers,
          preview: rows.slice(0, 5),
          totalRows: rows.length,
        });
      } catch (err) {
        res.status(400).json({ error: `Preview failed: ${err.message}` });
      }
    },
  );
}
