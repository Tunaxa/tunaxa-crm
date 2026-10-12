import crypto from "node:crypto";
import { readDb, mutateDb } from "../store.js";
import { loadRecords, saveRecord } from "../db/legacy-records.js";
import { auth } from "../middleware/auth.js";
import { now } from "../helpers.js";
import { createRateLimiter } from "../services/rateLimit.js";

const publicLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 300,
  prefix: "web",
});
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

function visitorKey(req) {
  return (
    req.query.vid ||
    crypto
      .createHash("sha256")
      .update(
        `${req.ip}|${req.headers["user-agent"] || ""}|${req.query.page || ""}`,
      )
      .digest("hex")
      .slice(0, 24)
  );
}

export default function registerWebTrackingRoutes(app) {
  // Client-side tracking script injection
  app.get("/api/web/track.js", publicLimiter, (req, res) => {
    res.type("application/javascript");
    res
      .send(
        `
(function(){
  var vid = localStorage.getItem('nx_vid') || 'v_' + Math.random().toString(36).slice(2, 12);
  localStorage.setItem('nx_vid', vid);
  function track(type, extra){
    var url = '/api/web/event?vid=' + vid + '&type=' + type + '&page=' + encodeURIComponent(location.pathname) + (extra ? extra : '');
    new Image().src = url;
  }
  window.TunaxaTracker = { track: track };
  track('pageview');
  document.addEventListener('click', function(e){
    var el = e.target.closest && e.target.closest('a,button');
    if(el && el.href) track('click', '&url=' + encodeURIComponent(el.href));
  });
})();
`,
      )
      .replace(/\n/g, "");
  });

  // Image pixel for anonymous tracking (for form emails / old browsers)
  app.get("/api/web/pixel.gif", publicLimiter, (req, res) => {
    const id = visitorKey(req);
    trackEvent({
      vid: id,
      type: req.query.type || "pageview",
      page: req.query.page || "/",
      url: req.query.url || "",
    });
    res.writeHead(200, {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store",
    });
    res.end(PIXEL);
  });

  // Event logging endpoint (no auth — fires from visitor browsers)
  app.get("/api/web/event", publicLimiter, (req, res) => {
    const vid = String(req.query.vid || visitorKey(req));
    const type = String(req.query.type || "pageview");
    const page = String(req.query.page || "/").slice(0, 300);
    const url = String(req.query.url || "").slice(0, 1000);
    trackEvent({ vid, type, page, url });
    res.json({ ok: true });
  });

  app.post("/api/web/event", publicLimiter, (req, res) => {
    const vid = String(req.body.vid || visitorKey(req));
    const type = String(req.body.type || "pageview");
    const page = String(req.body.page || "/").slice(0, 300);
    const url = String(req.body.url || "").slice(0, 1000);
    trackEvent({ vid, type, page, url });
    res.json({ ok: true });
  });

  // Associate an anonymous visitor identity with an email (form submission / login)
  app.post("/api/web/identify", publicLimiter, async (req, res) => {
    const { vid, email } = req.body || {};
    if (!vid || !email)
      return res.status(400).json({ error: "vid and email are required" });
    let contactId = "";
    await mutateDb(async (db) => {
      if (!db.webVisits) db.webVisits = [];
      const contact = (await loadRecords('contacts', db)).find(
        (c) =>
          String(c.email || "").toLowerCase() === String(email).toLowerCase(),
      );
      const lead = (await loadRecords('leads', db)).find(
        (l) =>
          String(l.email || "").toLowerCase() === String(email).toLowerCase(),
      );
      const record = contact || lead;
      if (record) {
        contactId = record.id;
        const prior = db.webVisits.filter((v) => v.vid === vid);
        (prior || []).forEach((v) => {
          v.recordId = record.id;
          v.attributed = true;
        });
        if (db.webVisits.some((v) => v.vid === vid)) {
          record.firstVisitAt =
            record.firstVisitAt || prior[0]?.createdAt || now();
          record.lastVisitAt = now();
          record.visitCount = (record.visitCount || 0) + prior.length;
          record.attributionSource =
            prior[0]?.page || record.attributionSource || "";
        }
        await saveRecord(contact ? 'contacts' : 'leads', record, db);
      } else if ((db.webVisits || []).some((v) => v.vid === vid)) {
        db.pendingAttribution = db.pendingAttribution || [];
        db.pendingAttribution.unshift({ vid, email, createdAt: now() });
      }
    });
    res.json({ attributed: Boolean(contactId), contactId });
  });

  // Attribution report (auth required)
  const trackEvent = async ({ vid, type, page, url }) => {
    await mutateDb((db) => {
      if (!db.webVisits) db.webVisits = [];
      db.webVisits.unshift({
        id: `web_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        vid,
        type,
        page,
        url,
        ip: "",
        createdAt: now(),
      });
      if (db.webVisits.length > 5000) db.webVisits.length = 5000;
    }).catch(() => {});
  };
}

export function registerWebTrackingAuthRoutes(app) {
  app.get("/api/web/visitors", auth, async (req, res) => {
    const db = await readDb();
    const { days = 30 } = req.query;
    const since = new Date(Date.now() - Number(days) * 86400000).toISOString();
    const visits = (db.webVisits || []).filter((v) => v.createdAt >= since);
    const byVid = {};
    for (const v of visits) {
      if (!byVid[v.vid])
        byVid[v.vid] = {
          vid: v.vid,
          visits: 0,
          pages: new Set(),
          first: v.createdAt,
          last: v.createdAt,
          recordId: v.recordId || v.attributed ? v.recordId : "",
        };
      const entry = byVid[v.vid];
      entry.visits++;
      if (v.page) entry.pages.add(v.page);
      if (v.createdAt > entry.last) entry.last = v.createdAt;
    }
    const data = Object.values(byVid)
      .map((e) => ({
        ...e,
        pages: [...e.pages].slice(0, 10),
        pageCount: e.pages.size,
      }))
      .sort((a, b) => b.visits - a.visits);
    res.json({ data, total: data.length, days });
  });
}
