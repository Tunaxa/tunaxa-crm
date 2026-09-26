import { readDb, mutateDb } from "../store.js";
import { auth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { id, now } from "../helpers.js";
import { broadcast } from "./sse.js";

const STEPS = [
  {
    id: "profile",
    title: "Complete Your Profile",
    description: "Set your name and profile picture",
  },
  {
    id: "company",
    title: "Company Info",
    description: "Add your company name, industry, and website",
  },
  {
    id: "pipeline",
    title: "Setup Pipeline",
    description: "Customize your deal stages",
  },
  {
    id: "invite",
    title: "Invite Team",
    description: "Add teammates to your workspace",
  },
  {
    id: "import",
    title: "Import Data",
    description: "Import your existing contacts and leads",
  },
  {
    id: "done",
    title: "You're All Set!",
    description: "Start using Tunaxa CRM",
  },
];

const DEFAULT_STAGES = [
  "New",
  "Qualified",
  "Proposal",
  "Negotiation",
  "Won",
  "Lost",
];

export default function registerOnboardingRoutes(app) {
  app.get("/api/onboarding/status", auth, async (req, res) => {
    const db = await readDb();
    const onboarding = db.onboarding || {
      completed: false,
      currentStep: "profile",
      completedSteps: [],
      company: {},
      pipeline: {},
    };
    res.json({ ...onboarding, steps: STEPS });
  });

  app.post(
    "/api/onboarding/step",
    auth,
    requireRole("admin", "member"),
    async (req, res) => {
      const { step, data } = req.body;
      if (!STEPS.find((s) => s.id === step))
        return res.status(400).json({ error: "Invalid step" });

      const updated = await mutateDb((db) => {
        if (!db.onboarding)
          db.onboarding = {
            completed: false,
            currentStep: "profile",
            completedSteps: [],
            company: {},
            pipeline: {},
            invites: [],
          };
        const onb = db.onboarding;
        if (!onb.completedSteps.includes(step)) onb.completedSteps.push(step);

        if (step === "profile" && data) {
          const user = db.users.find((u) => u.id === req.user.id);
          if (user) {
            if (data.name) user.name = data.name;
            if (data.phone) user.phone = data.phone;
          }
        }
        if (step === "company" && data)
          onb.company = { ...onb.company, ...data };
        if (step === "pipeline" && data?.stages)
          onb.pipeline = { stages: data.stages };
        if (step === "invite" && data?.emails) onb.invites = data.emails;

        const nextIdx = STEPS.findIndex((s) => s.id === step) + 1;
        onb.currentStep = nextIdx < STEPS.length ? STEPS[nextIdx].id : "done";
        if (onb.currentStep === "done") onb.completed = true;

        if (step === "pipeline" && data?.stages) {
          db.settings.pipelineStages = data.stages;
        }
        if (step === "done") {
          db.audit.unshift({
            id: id("audit"),
            action: "Completed onboarding wizard",
            actor: req.user.name,
            createdAt: now(),
          });
        }
        return onb;
      });

      broadcast("onboarding.step_completed", {
        step,
        currentStep: updated.currentStep,
      }, req.user.workspaceId || "default");
      res.json(updated);
    },
  );

  app.post(
    "/api/onboarding/skip",
    auth,
    requireRole("admin", "member"),
    async (req, res) => {
      const updated = await mutateDb((db) => {
        if (!db.onboarding)
          db.onboarding = {
            completed: false,
            currentStep: "done",
            completedSteps: [],
            company: {},
            pipeline: {},
          };
        db.onboarding.completed = true;
        db.onboarding.currentStep = "done";
        db.onboarding.skippedAt = now();
        db.audit.unshift({
          id: id("audit"),
          action: "Skipped onboarding wizard",
          actor: req.user.name,
          createdAt: now(),
        });
        return db.onboarding;
      });
      res.json(updated);
    },
  );

  app.post(
    "/api/onboarding/reset",
    auth,
    requireRole("admin", "member"),
    async (req, res) => {
      const updated = await mutateDb((db) => {
        db.onboarding = {
          completed: false,
          currentStep: "profile",
          completedSteps: [],
          company: {},
          pipeline: {},
        };
        return db.onboarding;
      });
      res.json(updated);
    },
  );

  app.get("/api/onboarding/template", auth, async (req, res) => {
    const industry = req.query.industry || "general";
    const templates = {
      general: {
        stages: DEFAULT_STAGES,
        fields: ["name", "email", "phone", "company"],
      },
      saas: {
        stages: [
          "Lead",
          "Demo Scheduled",
          "Trial Started",
          "Proposal",
          "Negotiation",
          "Closed Won",
          "Closed Lost",
        ],
        fields: ["name", "email", "company", "mrr", "trialEnd"],
      },
      ecommerce: {
        stages: [
          "New Lead",
          "Product Interest",
          "Quote Sent",
          "Negotiation",
          "Order Placed",
          "Fulfilled",
          "Lost",
        ],
        fields: ["name", "email", "productInterest", "orderValue"],
      },
      real_estate: {
        stages: [
          "New Lead",
          "Site Visit",
          "Negotiation",
          "Booking",
          "Registration",
          "Lost",
        ],
        fields: ["name", "email", "phone", "budget", "location"],
      },
      agency: {
        stages: [
          "Inquiry",
          "Discovery Call",
          "Proposal Sent",
          "Revisions",
          "Contract Signed",
          "Project Start",
          "Lost",
        ],
        fields: ["name", "email", "company", "projectBudget", "timeline"],
      },
    };
    res.json(templates[industry] || templates.general);
  });
}
