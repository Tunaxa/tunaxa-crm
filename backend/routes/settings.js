import { readDb, mutateDb } from "../store.js";
import { auth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import { id, now, coerceBuiltIns } from "../helpers.js";
import { getSettings, DEFAULT_SETTINGS } from "../services/config.js";
import { resetTransporter as resetEmailTransporter } from "../services/email.js";
import { resetTransporter as resetSmtpTransporter } from "../services/smtp.js";
import { validate, SettingsSchema } from "../services/validate.js";
import { BUILT_IN_FIELDS, customFieldSpecs } from "../helpers.js";
import { EVENT_META, ACTION_META } from "../services/workflows.js";
import { checkOllamaStatus } from "../services/ai.js";
import { isAiConfigured, isTwilioConfigured } from "../services/config.js";
import { cacheGet, cacheSet, cacheFlush } from "../services/cache.js";
import { broadcast } from "./sse.js";
import { repoFor } from "../db/repositories/index.js";
import { PG_RESOURCES, pgToLegacy } from "../db/legacy-shape.js";
import {
  getFieldPermissions,
  applyFieldMasking,
  objectTypeOf,
} from "./permissions.js";

// Same idiom as tenantOf() in routes/resources.js, duplicated rather than
// imported: a route module reaching into another route module is how the two
// tenant checks drift apart. Server-derived, never taken from the body.
const tenantOf = (req) =>
  req.user?.workspaceId || req.user?.workspace_id || "default";

// Cap per entity group so one noisy resource cannot crowd out the others in the
// global search palette.
const SEARCH_GROUP_LIMIT = 10;

export default function registerSettingsRoutes(app) {
  /**
   * GET /api/dashboard
   * Protected. Aggregated sales/CRM metrics for the dashboard home view
   * (cached for 60s).
   * Response: 200 { pipeline, won, qualified, connected, leads, contacts,
   * companies, tasks, deals, recent }
   */
  app.get("/api/dashboard", auth, async (req, res) => {
    const cached = await cacheGet("dashboard");
    if (cached) return res.json(cached);
    const db = await readDb();
    const pipeline = db.deals
      .filter((x) => x.stage !== "won" && x.stage !== "lost")
      .reduce((sum, x) => sum + Number(x.value || 0), 0);
    const won = db.deals
      .filter((x) => x.stage === "won")
      .reduce((sum, x) => sum + Number(x.value || 0), 0);
    const qualified = db.leads.filter((x) => x.status === "Qualified").length;
    const connected = db.calls.filter(
      (x) => x.status === "Connected" || x.status === "Completed",
    ).length;
    const recent = [
      ...db.activities
        .filter((item) => !item.callId)
        .map((item) => ({
          id: item.id,
          kind: "activity",
          title: item.title || `${item.type || "Activity"}`,
          meta: item.contact || item.type || "Activity",
          icon: "activity",
          route: "/activities",
          createdAt: item.createdAt,
        })),
      ...db.calls.map((item) => ({
        id: item.id,
        kind: "call",
        title: item.contact || item.phone || "Call",
        meta: `${item.direction || "Outbound"} · ${item.status || "Logged"}`,
        icon: "phone",
        route: "/calls",
        createdAt: item.createdAt,
      })),
      ...db.tasks.map((item) => ({
        id: item.id,
        kind: "task",
        title: item.title || "Task",
        meta: `${item.status || "Open"} · ${item.owner || "Unassigned"}`,
        icon: "tasks",
        route: "/tasks",
        createdAt: item.createdAt,
      })),
    ]
      .filter((item) => item.createdAt)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 12);
    const result = {
      pipeline,
      won,
      qualified,
      connected,
      leads: db.leads.length,
      contacts: db.contacts.length,
      companies: db.companies.length,
      tasks: db.tasks.length,
      deals: db.deals.length,
      recent,
    };
    cacheSet("dashboard", result, 60);
    res.json(result);
  });

  /**
   * GET /api/search
   * Protected. Full-text search across leads, contacts, companies, deals,
   * tasks and recordings, with field masking applied per result.
   * PostgreSQL-backed entities are searched through their repository and
   * tenant-scoped in SQL; JSON-store entities are filtered in memory.
   * Query param: q - search term (required; empty query returns empty groups)
   * Response: 200 grouped by entity type, e.g.
   *   { leads: [], contacts: [], companies: [], deals: [], tasks: [], recordings: [] }
   *   Each group is capped at SEARCH_GROUP_LIMIT (10) entries.
   */
  app.get("/api/search", auth, async (req, res, next) => {
    const q = String(req.query.q || "")
      .toLowerCase()
      .trim();
    const db = await readDb();
    const groups = [
      ["leads", "Lead", "/leads", ["name", "company", "email", "phone"]],
      [
        "contacts",
        "Contact",
        "/contacts",
        ["name", "company", "email", "phone"],
      ],
      ["companies", "Company", "/companies", ["name", "industry", "country"]],
      ["deals", "Deal", "/pipeline", ["title", "company", "stage"]],
      ["tasks", "Task", "/tasks", ["title", "owner", "status"]],
      [
        "recordings",
        "Recording",
        "/recordings",
        ["title", "contact", "transcript"],
      ],
    ];
    // Results are returned grouped by entity type so the UI can render
    // per-type sections. Every group key is always present, even when empty.
    const out = Object.fromEntries(groups.map(([key]) => [key, []]));
    if (q) {
      try {
        for (const [key, type, route, fields] of groups) {
          // Field permissions still apply to search results: the palette must
          // not expose a value the record endpoint would mask.
          const fieldPerms = getFieldPermissions(
            db,
            objectTypeOf(key),
            req.user.role,
          );
          let rows;
          if (PG_RESOURCES.has(key)) {
            // Contacts, leads, companies, deals and tasks live in Postgres.
            // Reading db[key] here would always be empty, and omitting the
            // tenant would leak another workspace's records.
            const result = await repoFor(key).findAll({
              q,
              workspaceId: tenantOf(req),
              page: 1,
              limit: SEARCH_GROUP_LIMIT,
            });
            rows = result.data.map((row) =>
              coerceBuiltIns(key, pgToLegacy(row, key)),
            );
          } else {
            rows = (db[key] || []).filter((item) =>
              fields.some((field) =>
                String(item[field] ?? "")
                  .toLowerCase()
                  .includes(q),
              ),
            );
          }
          for (const row of rows) {
            if (out[key].length >= SEARCH_GROUP_LIMIT) break;
            const item = applyFieldMasking(row, fieldPerms);
            out[key].push({
              id: item.id,
              type,
              route,
              name: item.name || item.title || item.email || type,
              detail:
                item.company || item.email || item.stage || item.status || "",
            });
          }
        }
      } catch (err) {
        return next(err);
      }
    }
    res.json(out);
  });

  /**
   * GET /api/settings
   * Protected. Returns the workspace configuration object.
   * Response: 200 settings object (see services/config.js)
   */
  app.get("/api/settings", auth, async (req, res) => {
    res.json(await getSettings());
  });

  /**
   * PUT /api/settings
   * Admin-only. Merges workspace settings, validates them, and resets the
   * email/SMTP transporters.
   * Body (SettingsSchema): partial settings object
   * Response: 200 { settings }
   */
  app.put(
    "/api/settings",
    auth,
    requireAdmin,
    validate(SettingsSchema),
    async (req, res) => {
      const saved = await mutateDb((db) => {
        db.settings = { ...DEFAULT_SETTINGS, ...db.settings, ...req.body };
        db.audit.unshift({
          id: id("audit"),
          action: "Workspace settings updated",
          actor: req.user.name,
          createdAt: now(),
        });
        return db.settings;
      });
      resetEmailTransporter();
      resetSmtpTransporter();
      cacheFlush();
      broadcast("settings.updated", { by: req.user.name }, req.user.workspaceId || "default");
      res.json(saved);
    },
  );

  /**
   * GET /api/workflows/meta
   * Protected. Static workflow trigger-event and action metadata for the
   * visual builder.
   * Response: 200 { events, actions }
   */
  app.get("/api/workflows/meta", auth, (req, res) =>
    res.json({ events: EVENT_META, actions: ACTION_META }),
  );

  /**
   * GET /api/schema/:object
   * Protected. Returns the field schema (built-in + custom fields) for a CRM
   * object: leads, contacts, companies or deals.
   * Path param: :object - CRM object name
   * Response: 200 { object, fields: [{ key, label, type, required, options? }] }
   *           404 { error } for unknown objects
   */
  app.get("/api/schema/:object", auth, async (req, res) => {
    const object = String(req.params.object || "").toLowerCase();
    if (!(object in BUILT_IN_FIELDS))
      return res.status(404).json({ error: "Unknown object" });
    const db = await readDb();
    res.json({
      object,
      fields: [...BUILT_IN_FIELDS[object], ...customFieldSpecs(db, object)],
    });
  });

  /**
   * GET /api/twilio/status
   * Protected. Reports whether Twilio calling is configured.
   * Response: 200 { configured: boolean, number: string }
   */
  app.get("/api/twilio/status", auth, async (req, res) => {
    const settings = await getSettings();
    res.json({
      configured: isTwilioConfigured(settings),
      number: settings.twilioNumber || "",
    });
  });

  /**
   * GET /api/ai/status
   * Protected. Reports AI/Ollama configuration and connectivity status.
   * Response: 200 { configured: boolean, ...ollamaStatus }
   */
  app.get("/api/ai/status", auth, async (req, res) => {
    const settings = await getSettings();
    const status = await checkOllamaStatus(settings);
    res.json({ configured: isAiConfigured(settings), ...status });
  });
}
