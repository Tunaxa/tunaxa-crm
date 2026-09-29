import { readDb, mutateDb } from "../store.js";
import { auth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import { id, now } from "../helpers.js";
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

export default function registerSettingsRoutes(app) {
  /**
   * GET /api/dashboard
   * Protected. Aggregated sales/CRM metrics for the dashboard home view
   * (cached for 60s).
   * Response: 200 { pipeline, won, qualified, connected, leads, contacts, companies, tasks, deals, recent }
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
   * tasks and recordings.
   * Query param: q - search term (required)
   * Response: 200 [{ id, type, route, name, detail }] (max 20)
   */
  app.get("/api/search", auth, async (req, res) => {
    const q = String(req.query.q || "")
      .toLowerCase()
      .trim();
    if (!q) return res.json([]);
    const db = await readDb();
    const map = [
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
    const out = [];
    for (const [key, type, route, fields] of map) {
      for (const item of db[key]) {
        if (
          fields.some((field) =>
            String(item[field] || "")
              .toLowerCase()
              .includes(q),
          )
        )
          out.push({
            id: item.id,
            type,
            route,
            name: item.name || item.title || item.email || type,
            detail:
              item.company || item.email || item.stage || item.status || "",
          });
        if (out.length >= 20) break;
      }
    }
    res.json(out.slice(0, 20));
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
   * Admin-only. Merges workspace settings and resets email/SMTP transporters.
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
