// Public email engagement endpoints.
//
// Both routes are hit by third-party mail clients and proxies, so they are
// unauthenticated and must never throw: a tracking failure can never be allowed
// to break the recipient's experience. The open pixel always answers 200 with
// the GIF; the click route only redirects to a destination that passed the
// strict protocol check inside a valid signed token.

import { repoFor } from "../db/repositories/index.js";
import { verifyTrackingToken, isSafeDestinationUrl } from "../services/tracking.js";
import { now } from "../helpers.js";

// https://en.wikipedia.org/wiki/GIF#Animated_GIFs - a 1x1 transparent GIF.
const TRANSPARENT_1X1_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

// Mail clients, security scanners and link-preview bots routinely fetch a
// message several times in a burst. Collapse repeat opens of the same message
// inside this window so the timeline records engagement, not a prefetch storm.
const OPEN_THROTTLE_MS = 5000;

function sendTrackingPixel(res) {
  res.set({
    "Content-Type": "image/gif",
    "Content-Length": String(TRANSPARENT_1X1_GIF.length),
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  });
  res.status(200).end(TRANSPARENT_1X1_GIF);
}

function requestContext(req) {
  return {
    userAgent: req.headers["user-agent"] || "",
    ip: req.ip || "",
  };
}

export default function registerTrackingRoutes(app) {
  const recentOpens = new Map();

  // Open pixel: always returns the GIF, logs an email_open activity when the
  // token is valid and refers to a contact that exists in the token's workspace.
  app.get("/api/tracking/open/:token", async (req, res) => {
    const payload = verifyTrackingToken(req.params.token);
    if (payload) {
      try {
        const throttleKey = `${payload.workspaceId || "default"}:${payload.messageId || payload.contactId || ""}`;
        const lastSeen = recentOpens.get(throttleKey) || 0;
        if (Date.now() - lastSeen >= OPEN_THROTTLE_MS) {
          recentOpens.set(throttleKey, Date.now());
          const contact = payload.contactId
            ? await repoFor("contacts").findById(payload.contactId, payload.workspaceId)
            : null;
          if (contact) {
            const { userAgent, ip } = requestContext(req);
            await repoFor("activities").create({
              workspace_id: payload.workspaceId,
              type: "email_open",
              title: "Email opened",
              subject: "Email opened",
              description: `Recipient opened email${payload.messageId ? ` (${payload.messageId})` : ""}`,
              contact_id: payload.contactId,
              deal_id: payload.dealId || null,
              entity_type: "contact",
              entity_id: payload.contactId,
              direction: "inbound",
              metadata: {
                messageId: payload.messageId || null,
                userAgent,
                ip,
                openedAt: now(),
              },
            });
          }
        }
      } catch (error) {
        // A tracking write failing must never break the pixel response.
        console.error("[tracking] failed to record email_open:", error?.message || error);
      }
    }
    sendTrackingPixel(res);
  });

  // Click redirect: reject malformed tokens and unsafe destinations, otherwise
  // log the click and 302 the recipient to the signed destination.
  app.get("/api/tracking/click/:token", async (req, res) => {
    const payload = verifyTrackingToken(req.params.token);
    if (!payload) {
      return res.status(400).json({ error: "Invalid or expired tracking token" });
    }
    if (!isSafeDestinationUrl(payload.targetUrl)) {
      return res.status(400).json({ error: "Invalid or unsafe destination URL" });
    }

    try {
      const contact = payload.contactId
        ? await repoFor("contacts").findById(payload.contactId, payload.workspaceId)
        : null;
      if (contact) {
        const { userAgent, ip } = requestContext(req);
        await repoFor("activities").create({
          workspace_id: payload.workspaceId,
          type: "email_click",
          title: "Email link clicked",
          subject: "Email link clicked",
          description: `Recipient clicked link: ${payload.targetUrl}`,
          contact_id: payload.contactId,
          deal_id: payload.dealId || null,
          entity_type: "contact",
          entity_id: payload.contactId,
          direction: "inbound",
          metadata: {
            messageId: payload.messageId || null,
            targetUrl: payload.targetUrl,
            userAgent,
            ip,
            clickedAt: now(),
          },
        });
      }
    } catch (error) {
      console.error("[tracking] failed to record email_click:", error?.message || error);
    }

    return res.redirect(302, payload.targetUrl);
  });
}
