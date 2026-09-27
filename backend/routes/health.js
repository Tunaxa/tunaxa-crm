import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { getDeepHealthStatus } from "../services/health.js";

/**
 * Deep health is admin-only.
 *
 * The report discloses which subsystems are configured and which are not, which
 * is reconnaissance for anyone probing a public instance, so it sits behind the
 * same role check as the settings and audit surfaces rather than next to the
 * public liveness probe.
 */
export default function registerHealthRoutes(app) {
  app.get("/api/health/deep", auth, requireRole("admin"), async (req, res) => {
    let report;
    try {
      report = await getDeepHealthStatus();
    } catch (error) {
      // Probes are written not to throw, so reaching this means something
      // structural failed. Answer 503 rather than letting Express turn it into
      // an opaque 500, since the caller is a health checker.
      res.status(503).json({
        status: "error",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        subsystems: {},
        error: error.message,
      });
      return;
    }

    // Only an unreachable database is a 503. Redis, SMTP and AI degradations are
    // reported with a 200 on purpose: they return 200 because the API is still
    // serving, and a load balancer that pulls this instance out for a missing AI
    // key would be reacting to the wrong signal.
    res.status(report.status === "error" ? 503 : 200).json(report);
  });
}
