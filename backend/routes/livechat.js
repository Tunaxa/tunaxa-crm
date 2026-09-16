import { readDb, mutateDb } from "../store.js";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { id, now } from "../helpers.js";
import { createRateLimiter } from "../services/rateLimit.js";

const publicLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 120,
  prefix: "chat",
});

export const DEFAULT_BOT_FLOW = [
  {
    intent: "sales",
    trigger: /(quote|price|pricing|cost|buy|purchase|demo|trial)/i,
    reply:
      "Great question! Our pricing starts at $29/mo per user. Would you like a demo?",
  },
  {
    intent: "support",
    trigger: /(help|issue|problem|broken|error|bug|support)/i,
    reply: "I can help with that. Could you describe the issue you are facing?",
  },
  {
    intent: "human",
    trigger: /(agent|human|person|representative|talk to someone)/i,
    reply: "Sure, I will connect you with a human agent right away.",
  },
  {
    intent: "hours",
    trigger: /(hours|when are you open|time)/i,
    reply: "Our team is available Monday to Friday, 9 AM to 6 PM UTC.",
  },
];

function botReply(text, flow) {
  if (!text) return { reply: "Hi! How can I help you today?", handoff: false };
  for (const node of flow || DEFAULT_BOT_FLOW) {
    try {
      if (node.trigger instanceof RegExp && node.trigger.test(text)) {
        return {
          reply: node.reply,
          handoff: node.intent === "human",
          intent: node.intent,
        };
      }
    } catch (error) {
      if (error && error.name !== "AbortError") throw error;
    }
  }
  return {
    reply:
      "Thanks for your message. Our team reviews inquiries within business hours.",
    handoff: false,
    intent: "default",
  };
}

export default function registerLiveChatRoutes(app) {
  app.get("/api/livechat/widget-config", auth, async (req, res) => {
    const db = await readDb();
    res.json(
      db.chatConfig || {
        enabled: true,
        title: "Tunaxa Chat",
        greeting: "Hi! How can we help?",
        primaryColor: "#159ddd",
        botFlow: DEFAULT_BOT_FLOW,
      },
    );
  });

  app.put(
    "/api/livechat/widget-config",
    auth,
    requireRole("admin"),
    async (req, res) => {
      const saved = await mutateDb((db) => {
        db.chatConfig = {
          enabled: true,
          title: "Tunaxa Chat",
          greeting: "Hi! How can we help?",
          primaryColor: "#159ddd",
          botFlow: DEFAULT_BOT_FLOW,
          ...(db.chatConfig || {}),
          ...req.body,
        };
        return db.chatConfig;
      });
      res.json(saved);
    },
  );

  // Visitor-facing chat endpoint (no auth)
  app.get("/api/livechat/session", publicLimiter, async (req, res) => {
    const db = await readDb();
    const cfg = db.chatConfig || {
      enabled: true,
      title: "Tunaxa Chat",
      greeting: "Hi! How can we help?",
      primaryColor: "#159ddd",
      botFlow: DEFAULT_BOT_FLOW,
    };
    res.json({
      enabled: cfg.enabled,
      title: cfg.title,
      greeting: cfg.greeting,
      primaryColor: cfg.primaryColor,
    });
  });

  // Bot decision endpoint (handles a visitor message)
  app.post("/api/livechat/message", publicLimiter, async (req, res) => {
    const { text } = req.body || {};
    const db = await readDb();
    const cfg = db.chatConfig || { botFlow: DEFAULT_BOT_FLOW };
    const result = botReply(String(text || ""), cfg.botFlow);
    await mutateDb((d) => {
      if (!d.chatConversations) d.chatConversations = [];
      d.chatConversations.unshift({
        id: id("chatMsg"),
        message: String(text || ""),
        reply: result.reply,
        handoff: result.handoff,
        intent: result.intent,
        createdAt: now(),
      });
    });
    res.json(result);
  });

  // Agent message (requires auth)
  app.post(
    "/api/livechat/agent-message",
    auth,
    requireRole("admin", "member"),
    async (req, res) => {
      const { to, body } = req.body || {};
      if (!to || !body)
        return res.status(400).json({ error: "to and body are required" });
      const saved = await mutateDb((db) => {
        if (!db.chatConversations) db.chatConversations = [];
        const item = {
          id: id("chatMsg"),
          to,
          body,
          agent: req.user.name,
          createdAt: now(),
        };
        db.chatConversations.unshift(item);
        return item;
      });
      res.status(201).json(saved);
    },
  );

  app.get("/api/livechat/conversations", auth, async (req, res) => {
    const db = await readDb();
    res.json({
      data: (db.chatConversations || []).slice(0, 200),
      total: (db.chatConversations || []).length,
    });
  });
}
