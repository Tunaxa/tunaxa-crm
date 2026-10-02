export type NavItem = { path: string; label: string; icon: string };
export type NavGroup = { label: string; items: NavItem[] };

export const navGroups: NavGroup[] = [
  { label: "nav.overview", items: [{ path: "/dashboard", label: "nav.dashboard", icon: "dashboard" }] },
  {
    label: "nav.sales",
    items: [
      { path: "/leads", label: "nav.leads", icon: "lead" },
      { path: "/contacts", label: "nav.contacts", icon: "contacts" },
      { path: "/companies", label: "nav.companies", icon: "companies" },
      { path: "/pipeline", label: "nav.pipeline", icon: "pipeline" },
    ],
  },
  {
    label: "nav.marketing",
    items: [
      { path: "/campaigns", label: "nav.campaigns", icon: "campaign" },
      { path: "/marketing-emails", label: "nav.marketingEmails", icon: "mail" },
      { path: "/events", label: "nav.events", icon: "event" },
      { path: "/email-lists", label: "nav.emailLists", icon: "inbox" },
      { path: "/landing-pages", label: "nav.landingPages", icon: "landing" },
      { path: "/forms", label: "nav.forms", icon: "form" },
    ],
  },
  {
    label: "nav.revenue",
    items: [
      { path: "/quotes", label: "nav.quotes", icon: "quote" },
      { path: "/contracts", label: "nav.contracts", icon: "contract" },
      { path: "/products", label: "nav.products", icon: "cart" },
      { path: "/orders", label: "nav.orders", icon: "send" },
    ],
  },
  {
    label: "nav.financial",
    items: [
      { path: "/finance", label: "nav.finance", icon: "money" },
      { path: "/invoices", label: "nav.invoices", icon: "invoice" },
      { path: "/expenses", label: "nav.expenses", icon: "reports" },
      { path: "/forecast", label: "nav.forecast", icon: "trend" },
    ],
  },
  {
    label: "nav.service",
    items: [
      { path: "/surveys", label: "nav.surveys", icon: "survey" },
      { path: "/survey-responses", label: "nav.surveyResponses", icon: "response" },
      { path: "/portal", label: "nav.portal", icon: "portal" },
    ],
  },
  {
    label: "nav.hr",
    items: [
      { path: "/employees", label: "nav.employees", icon: "employee" },
      { path: "/leave", label: "nav.leave", icon: "leave" },
      { path: "/attendance", label: "nav.attendance", icon: "clockIn" },
    ],
  },
  {
    label: "nav.work",
    items: [
      { path: "/activities", label: "nav.activities", icon: "activity" },
      { path: "/tasks", label: "nav.tasks", icon: "tasks" },
      { path: "/calendar", label: "nav.calendar", icon: "calendar" },
      { path: "/calls", label: "nav.calls", icon: "phone" },
      { path: "/recordings", label: "nav.recordings", icon: "recording" },
      { path: "/inbox", label: "nav.inbox", icon: "inbox" },
    ],
  },
  {
    label: "nav.automation",
    items: [
      { path: "/workflows", label: "nav.workflows", icon: "workflow" },
      { path: "/webhooks", label: "nav.webhooks", icon: "webhook" },
      { path: "/sequences", label: "nav.sequences", icon: "sequence" },
    ],
  },
  {
    label: "nav.analytics",
    items: [
      { path: "/reports", label: "nav.reports", icon: "reports" },
      { path: "/goals", label: "nav.goals", icon: "goal" },
      { path: "/duplicates", label: "nav.duplicates", icon: "duplicate" },
      { path: "/audit", label: "nav.audit", icon: "shield" },
    ],
  },
  {
    label: "nav.workspace",
    items: [
      { path: "/team", label: "nav.team", icon: "team" },
      { path: "/fields", label: "nav.fields", icon: "fields" },
      { path: "/settings", label: "nav.settings", icon: "settings" },
    ],
  },
];

export const titles = Object.fromEntries(
  navGroups.flatMap((group) => group.items.map((item) => [item.path, item.label])),
);