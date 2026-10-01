import { auth, createAuth } from "../middleware/auth.js";

const sseAuth = createAuth({ allowQueryToken: true });

const clients = new Map();

/**
 * Broadcast an SSE event to the clients whose authenticated room matches the
 * given scope.
 *
 * Events are never delivered globally: a workspaceId and/or userId scope is
 * required. A client only receives the event when it matches every provided
 * scope, so sockets authenticated for another workspace (or another user) never
 * receive the payload.
 *
 * @param {string} event Event name.
 * @param {unknown} data JSON-serializable payload.
 * @param {string | { workspaceId?: string, userId?: string }} [scope]
 *   A workspace id (legacy string form) or an explicit room scope object.
 * @returns {number} Number of clients the event was written to.
 */
export function broadcast(event, data, scope) {
  const { workspaceId, userId } =
    typeof scope === "string" ? { workspaceId: scope } : scope || {};

  if (!workspaceId && !userId) return 0; // never broadcast globally

  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  let delivered = 0;

  for (const [, client] of clients) {
    if (workspaceId && client.workspaceId !== workspaceId) continue;
    if (userId && client.userId !== userId) continue;
    client.res.write(payload);
    delivered += 1;
  }

  return delivered;
}

/**
 * Convenience helper for the user-room channel: deliver an event only to the
 * sockets authenticated as `userId`.
 */
export function broadcastToUser(userId, event, data) {
  return broadcast(event, data, { userId });
}

export default function registerSseRoutes(app) {
  app.get("/api/events", sseAuth, (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const workspaceId = req.user.workspaceId || "default";
    res.write(
      `event: connected\ndata: ${JSON.stringify({ userId: req.user.id, workspaceId })}\n\n`,
    );

    const clientId = `${req.user.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    clients.set(clientId, {
      res,
      userId: req.user.id,
      workspaceId,
    });

    const heartbeat = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, 30_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(clientId);
    });
  });

  app.get("/api/events/clients", auth, (req, res) => {
    res.json({ count: clients.size });
  });
}
