import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { broadcast } from "./sse.js";
import {
  INTEGRATION_EVENT,
  deleteSlackWebhook,
  getIntegrationStatuses,
  saveSlackWebhook,
  testSlackWebhook,
  workspaceIdOf,
} from "../services/integrations.js";

function sendError(res, error) {
  const status = Number(error?.status) >= 400 && Number(error?.status) < 600
    ? Number(error.status)
    : 500;
  res.status(status).json({
    error: status === 500 ? "Internal server error" : error.message,
  });
}

export default function registerIntegrationRoutes(app) {
  app.get("/api/integrations", auth, async (req, res) => {
    try {
      res.json(await getIntegrationStatuses(workspaceIdOf(req.user)));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put(
    "/api/integrations/slack",
    auth,
    requireRole("admin", "owner"),
    async (req, res) => {
      try {
        const workspaceId = workspaceIdOf(req.user);
        const status = await saveSlackWebhook(
          workspaceId,
          req.body,
          req.user?.name || req.user?.id || "Unknown",
        );
        broadcast(
          INTEGRATION_EVENT,
          { channel: "slack", configured: status.slack.configured },
          workspaceId,
        );
        res.json(status);
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  app.delete(
    "/api/integrations/slack",
    auth,
    requireRole("admin", "owner"),
    async (req, res) => {
      try {
        const workspaceId = workspaceIdOf(req.user);
        const status = await deleteSlackWebhook(
          workspaceId,
          req.user?.name || req.user?.id || "Unknown",
        );
        broadcast(
          INTEGRATION_EVENT,
          { channel: "slack", configured: status.slack.configured },
          workspaceId,
        );
        res.json(status);
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  app.post(
    "/api/integrations/slack/test",
    auth,
    requireRole("admin", "owner"),
    async (req, res) => {
      try {
        res.json(await testSlackWebhook(workspaceIdOf(req.user)));
      } catch (error) {
        sendError(res, error);
      }
    },
  );
}
