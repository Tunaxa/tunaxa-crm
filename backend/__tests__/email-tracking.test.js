// Email open-tracking pixel & click-redirect engine.
//
// Two layers:
//   1. Pure unit tests (no database): HMAC token round-trip/tamper/expiry, the
//      safe-destination protocol check, and the HTML helpers (pixel injection
//      and link wrapping).
//   2. End-to-end HTTP tests (skipped when Postgres is unreachable): the public
//      GET /api/tracking/open/:token and /api/tracking/click/:token endpoints,
//      asserting the GIF/redirect responses and the email_open / email_click
//      activities they write onto the recipient's timeline, plus open-redirect
//      defense and workspace boundaries.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { resetTestDb, cleanupTestDb } from "./setup.js";
import { query } from "../db/pg.js";
import {
  createTrackingToken,
  verifyTrackingToken,
  generateOpenToken,
  generateClickToken,
  isSafeDestinationUrl,
  injectTrackingPixel,
  wrapTrackingLinks,
  TRACKING_TOKEN_TTL_MS,
} from "../services/tracking.js";

const ACME = "ws_acme";
const GLOBEX = "ws_globex";
const SARAH_EMAIL = "sarah.connor@cyberdyne.com";
const SARAH_ID = "cnt_track_sarah";
const GLOBEX_ID = "cnt_track_globex";
const BASE_URL = "https://crm.tunaxa.com";

let pgReady = false;
try {
  await query("SELECT 1 FROM contacts LIMIT 1");
  pgReady = true;
} catch (error) {
  console.warn(
    `[email-tracking] Postgres is unreachable (${error.code || error.message}) - skipping database and HTTP assertions. Set PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE and re-run.`,
  );
}

// ===========================================================================
describe("Tracking token & HTML utilities", () => {
  it("round-trips a signed payload and keeps the TTL default", () => {
    const token = createTrackingToken({
      contactId: SARAH_ID,
      workspaceId: ACME,
      dealId: "deal_1",
      messageId: "message_1",
    });
    const payload = verifyTrackingToken(token);
    expect(payload).toBeTruthy();
    expect(payload.contactId).toBe(SARAH_ID);
    expect(payload.workspaceId).toBe(ACME);
    expect(payload.dealId).toBe("deal_1");
    expect(payload.messageId).toBe("message_1");
    expect(payload.exp).toBeGreaterThan(Date.now() + TRACKING_TOKEN_TTL_MS - 5000);
  });

  it("generates open tokens without a target and click tokens with one", () => {
    const open = verifyTrackingToken(generateOpenToken({ contactId: SARAH_ID, workspaceId: ACME }));
    expect(open.targetUrl).toBeNull();

    const click = verifyTrackingToken(
      generateClickToken({ contactId: SARAH_ID, workspaceId: ACME, targetUrl: "https://tunaxa.com/demo" }),
    );
    expect(click.targetUrl).toBe("https://tunaxa.com/demo");
  });

  it("rejects tampered, malformed and expired tokens", () => {
    const token = generateOpenToken({ contactId: SARAH_ID, workspaceId: ACME, messageId: "m1" });
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect(verifyTrackingToken(tampered)).toBeNull();

    const [payloadB64, sig] = token.split(".");
    const swappedPayload = Buffer.from(
      JSON.stringify({ contactId: "attacker", workspaceId: GLOBEX, exp: Date.now() + 100000 }),
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(verifyTrackingToken(`${swappedPayload}.${sig}`)).toBeNull();
    expect(verifyTrackingToken(payloadB64)).toBeNull();

    expect(verifyTrackingToken("not-a-token")).toBeNull();
    expect(verifyTrackingToken("")).toBeNull();
    expect(verifyTrackingToken("a.b")).toBeNull();
    expect(verifyTrackingToken(`${payloadB64}.`)).toBeNull();

    const expired = generateOpenToken({ contactId: SARAH_ID, workspaceId: ACME, exp: Date.now() - 1000 });
    expect(verifyTrackingToken(expired)).toBeNull();
  });

  it("only accepts absolute http/https destinations", () => {
    expect(isSafeDestinationUrl("https://tunaxa.com/demo")).toBe(true);
    expect(isSafeDestinationUrl("http://tunaxa.com")).toBe(true);
    expect(isSafeDestinationUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeDestinationUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
    expect(isSafeDestinationUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeDestinationUrl("//evil.example.com")).toBe(false);
    expect(isSafeDestinationUrl("/relative/path")).toBe(false);
    expect(isSafeDestinationUrl("mailto:a@b.com")).toBe(false);
    expect(isSafeDestinationUrl("")).toBe(false);
    expect(isSafeDestinationUrl(null)).toBe(false);
  });

  it("injects the pixel before </body> and appends when there is no body", () => {
    const token = "tok.en";
    const withBody = injectTrackingPixel("<html><body>Hi</body></html>", token, BASE_URL);
    expect(withBody).toContain(`<img src="${BASE_URL}/api/tracking/open/${token}"`);
    expect(withBody.indexOf("<img")).toBeLessThan(withBody.indexOf("</body>"));

    const withoutBody = injectTrackingPixel("<div>Hi</div>", token, BASE_URL);
    expect(withoutBody.endsWith("/>")).toBe(true);
    expect(withoutBody).toContain(`src="${BASE_URL}/api/tracking/open/${token}"`);
  });

  it("wraps http(s) links but preserves mailto, anchors, and unsubscribe", () => {
    const html =
      '<a href="https://tunaxa.com/demo">demo</a>' +
      '<a href="mailto:sales@tunaxa.com">mail</a>' +
      '<a href="#section">jump</a>' +
      '<a href="https://tunaxa.com/unsubscribe?u=1">unsubscribe</a>' +
      '<a href="tel:+15551234">call</a>';
    const tokenFn = (url) => `token(${url})`;
    const wrapped = wrapTrackingLinks(html, tokenFn, BASE_URL);

    expect(wrapped).toContain(`href="${BASE_URL}/api/tracking/click/token(https://tunaxa.com/demo)"`);
    expect(wrapped).toContain('href="mailto:sales@tunaxa.com"');
    expect(wrapped).toContain('href="#section"');
    expect(wrapped).toContain('href="https://tunaxa.com/unsubscribe?u=1"');
    expect(wrapped).toContain('href="tel:+15551234"');
  });
});

// ===========================================================================
describe.skipIf(!pgReady)("Email tracking endpoints", () => {
  let app;

  beforeAll(async () => {
    await resetTestDb();
    const mod = await import("../server.js");
    app = mod.app;
  });

  beforeEach(async () => {
    await resetTestDb();
    await query(
      `INSERT INTO contacts (id, workspace_id, first_name, last_name, email)
       VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)`,
      [SARAH_ID, ACME, "Sarah", "Connor", SARAH_EMAIL, GLOBEX_ID, GLOBEX, "Kyle", "Reese", "kyle@globex.com"],
    );
  });

  afterAll(() => cleanupTestDb());

  it("serves a 1x1 GIF with cache-busting headers and logs email_open", async () => {
    const token = generateOpenToken({ contactId: SARAH_ID, workspaceId: ACME, messageId: "msg_open_1" });
    const res = await request(app).get(`/api/tracking/open/${token}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/gif");
    expect(res.headers["cache-control"]).toContain("no-store");

    const result = await query("SELECT * FROM activities WHERE type = 'email_open'");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].contact_id).toBe(SARAH_ID);
    expect(result.rows[0].workspace_id).toBe(ACME);
    expect(result.rows[0].metadata.messageId).toBe("msg_open_1");
  });

  it("throttles rapid duplicate opens of the same message", async () => {
    const token = generateOpenToken({ contactId: SARAH_ID, workspaceId: ACME, messageId: "msg_spam_1" });
    await request(app).get(`/api/tracking/open/${token}`);
    await request(app).get(`/api/tracking/open/${token}`);

    const result = await query("SELECT * FROM activities WHERE type = 'email_open'");
    expect(result.rows).toHaveLength(1);
  });

  it("redirects tracked clicks with 302 and logs email_click", async () => {
    const token = generateClickToken({
      contactId: SARAH_ID,
      workspaceId: ACME,
      messageId: "msg_click_1",
      targetUrl: "https://tunaxa.com/demo",
    });
    const res = await request(app).get(`/api/tracking/click/${token}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://tunaxa.com/demo");

    const result = await query("SELECT * FROM activities WHERE type = 'email_click'");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].contact_id).toBe(SARAH_ID);
    expect(result.rows[0].workspace_id).toBe(ACME);
    expect(result.rows[0].metadata.targetUrl).toBe("https://tunaxa.com/demo");
  });

  it("rejects javascript: destinations with 400 and records nothing", async () => {
    const token = generateClickToken({ contactId: SARAH_ID, workspaceId: ACME, targetUrl: "javascript:alert(1)" });
    const res = await request(app).get(`/api/tracking/click/${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid or unsafe destination URL");
    const result = await query("SELECT * FROM activities");
    expect(result.rows).toHaveLength(0);
  });

  it("rejects data:, file: and protocol-relative destinations", async () => {
    for (const targetUrl of ["data:text/html,<script>1</script>", "file:///etc/passwd", "//evil.example.com"]) {
      const token = generateClickToken({ contactId: SARAH_ID, workspaceId: ACME, targetUrl });
      const res = await request(app).get(`/api/tracking/click/${token}`);
      expect(res.status).toBe(400);
    }
    const result = await query("SELECT * FROM activities");
    expect(result.rows).toHaveLength(0);
  });

  it("fails open gracefully on a tampered open token and 400s on a tampered click", async () => {
    const openToken = generateOpenToken({ contactId: SARAH_ID, workspaceId: ACME, messageId: "msg_tamper_1" });
    const tamperedOpen = `${openToken.slice(0, -2)}xy`;
    const openRes = await request(app).get(`/api/tracking/open/${tamperedOpen}`);
    expect(openRes.status).toBe(200);
    expect(openRes.headers["content-type"]).toContain("image/gif");

    const clickToken = generateClickToken({
      contactId: SARAH_ID,
      workspaceId: ACME,
      targetUrl: "https://tunaxa.com/demo",
    });
    const tamperedClick = `${clickToken.slice(0, -2)}xy`;
    const clickRes = await request(app).get(`/api/tracking/click/${tamperedClick}`);
    expect(clickRes.status).toBe(400);

    const result = await query("SELECT * FROM activities");
    expect(result.rows).toHaveLength(0);
  });

  it("scopes activities to the token's workspace across tenants", async () => {
    const acmeToken = generateOpenToken({ contactId: SARAH_ID, workspaceId: ACME, messageId: "msg_tenant_acme" });
    const globexToken = generateOpenToken({ contactId: GLOBEX_ID, workspaceId: GLOBEX, messageId: "msg_tenant_globex" });
    await request(app).get(`/api/tracking/open/${acmeToken}`);
    await request(app).get(`/api/tracking/open/${globexToken}`);

    const result = await query("SELECT workspace_id, contact_id FROM activities WHERE type = 'email_open' ORDER BY workspace_id");
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.workspace_id).sort()).toEqual([ACME, GLOBEX]);
    expect(result.rows.find((r) => r.workspace_id === ACME).contact_id).toBe(SARAH_ID);
    expect(result.rows.find((r) => r.workspace_id === GLOBEX).contact_id).toBe(GLOBEX_ID);
  });
});
