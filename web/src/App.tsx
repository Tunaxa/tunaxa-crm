import { WorkflowPicker } from "./pages/workflows/WorkflowPicker";
import { WorkflowDetailPage } from "./pages/workflows/WorkflowDetailPage";

import { useForm } from "react-hook-form";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Icon } from "./components/Icon";
import {
  Avatar,
  Badge,
  Drawer,
  Empty,
  Modal,
  PageHeader,
  PhotoField,
  Toggle,
  money,
  CornerBrackets,
  PixelIndicator,
  CutButton,
  RevenueFlowCanvas,
} from "./components/ui";
import { AxacrmLogo } from "./components/common/AxacrmLogo";
import { HomePage } from "./pages/HomePage";
import { PricingPage } from "./pages/PricingPage";
import { AppProvider, useApp } from "./context/AppContext";
import { LayoutGrid, Sun, Moon } from "lucide-react";
import { EcosystemMenu } from "./components/layout/EcosystemMenu";
import { api, getToken, json, setToken } from "./lib/api";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { CustomReportBuilder } from "./components/reports/CustomReportBuilder";
import {
  invitationIsExpired,
  normalizeInvitations,
  type PendingInvitation,
} from "./components/team/invitations";
import { OnboardingGate } from "./components/onboarding/OnboardingWizard";
import {
  GoalProgress,
  getCrossedGoalMilestone,
  getGoalProgress,
  type GoalMilestone,
} from "./components/goals/GoalProgress";
import { QuoteForm } from "./components/quotes/QuoteForm";
import { GenerateInvoiceButton } from "./components/quotes/GenerateInvoiceButton";
import { useResource } from "./lib/useResource";
import { useSSE, type SSEHandlers } from "./lib/useSSE";
import i18n from "./i18n";

const LeadsPage = lazy(() =>
  import("./pages/sales/LeadsPage").then((module) => ({ default: module.LeadsPage })),
);
const ContactsPage = lazy(() =>
  import("./pages/sales/ContactsPage").then((module) => ({ default: module.ContactsPage })),
);
const CompaniesPage = lazy(() =>
  import("./pages/sales/CompaniesPage").then((module) => ({ default: module.CompaniesPage })),
);
const PipelinePage = lazy(() =>
  import("./pages/sales/PipelinePage").then((module) => ({ default: module.PipelinePage })),
);

const logo = "/assets/tunaxa-logo.png";
type Row = { id: string; [key: string]: any };
type NavItem = { path: string; label: string; icon: string };
type NavGroup = { label: string; items: NavItem[] };

const navGroups: NavGroup[] = [
  {
    label: "nav.overview",
    items: [{ path: "/dashboard", label: "nav.dashboard", icon: "dashboard" }],
  },
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
      {
        path: "/survey-responses",
        label: "nav.surveyResponses",
        icon: "response",
      },
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

const titles = Object.fromEntries(
  navGroups.flatMap((group) =>
    group.items.map((item) => [item.path, item.label]),
  ),
);
const stages = [
  { id: "new", label: "New" },
  { id: "qualified", label: "Qualified" },
  { id: "proposal", label: "Proposal" },
  { id: "negotiation", label: "Negotiation" },
  { id: "won", label: "Won" },
];
function applyPreferences(preferences: any) {
  const theme = preferences?.theme === "dark";
  document.documentElement.classList.toggle("dark", theme);
  localStorage.setItem("tunaxa.theme", theme ? "dark" : "light");

  if (typeof preferences?.sidebarCollapsed === "boolean") {
    localStorage.setItem(
      "tunaxa.sidebar",
      preferences.sidebarCollapsed ? "1" : "0",
    );
  }

  if (Number.isInteger(preferences?.pageSize) && preferences.pageSize > 0) {
    localStorage.setItem("tunaxa.pageSize", String(preferences.pageSize));
  }
}
function getPageSize() {
  const value = Number(localStorage.getItem("tunaxa.pageSize"));
  return Number.isInteger(value) && value > 0 ? value : 25;
}

function savePageSize(pageSize: number) {
  localStorage.setItem("tunaxa.pageSize", String(pageSize));
  api("/users/me/preferences", json("PUT", { pageSize })).catch(() => {});
}
function AuthScreen({
  onNavigateToHome,
  onNavigateToPricing,
  onNavigateToDemo,
}: {
  onNavigateToHome?: () => void;
  onNavigateToPricing?: () => void;
  onNavigateToDemo?: () => void;
}) {
  const { setUser, toast } = useApp();
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"login" | "setup">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState(
    document.documentElement.classList.contains("dark"),
  );

  function toggleTheme() {
    const next = !theme;
    setTheme(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("tunaxa.theme", next ? "dark" : "light");
  }

  useEffect(() => {
    api<{ needsSetup: boolean }>("/auth/status")
      .then((result) => {
        setNeedsSetup(result.needsSetup);
        if (result.needsSetup) setMode("setup");
      })
      .catch((error) => toast(error.message, "error"));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const endpoint = mode === "setup" ? "/auth/setup" : "/auth/login";
      const body =
        mode === "setup" ? { name, email, password } : { email, password };
      const result = await api<{ token: string; user: any }>(
        endpoint,
        json("POST", body),
      );
      setToken(result.token);

      const preferences = result.user.preferences || {
        theme: "light",
        sidebarCollapsed: false,
        pageSize: 25,
      };

      applyPreferences(preferences);
      setUser(result.user);
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (needsSetup === null)
    return (
      <main className="min-h-screen bg-[#f7f7f7] dark:bg-[#090d13] flex items-center justify-center p-4 tunaxa-grid-texture font-mono">
        <div className="border border-[#d1d1d1] dark:border-[#21262d] bg-white dark:bg-[#161b22] p-8 text-center relative shadow-sm max-w-sm w-full">
          <CornerBrackets stroke="#3b82f6" size={8} />
          <PixelIndicator active pulseColor="blue" className="mx-auto mb-3" />
          <div className="text-xs text-[#71717a] dark:text-[#8b949e]">
            INITIALIZING AXA CRM WORKSPACE…
          </div>
        </div>
      </main>
    );

  return (
    <main className="min-h-screen bg-[#f7f7f7] dark:bg-[#090d13] text-[#1e2329] dark:text-[#f3f4f6] font-sans antialiased flex flex-col md:flex-row tunaxa-grid-texture relative selection:bg-[#3b82f6]/20">
      {/* Left hero section with Revenue Flow Canvas */}
      <section className="relative w-full md:w-1/2 min-h-[360px] md:min-h-screen flex flex-col justify-between p-8 sm:p-12 border-b md:border-b-0 md:border-r border-[#d1d1d1] dark:border-[#21262d] bg-white/60 dark:bg-[#090d13]/80 backdrop-blur-xs overflow-hidden">
        {/* Background Canvas Animation */}
        <div className="absolute inset-0 pointer-events-none opacity-40 dark:opacity-30">
          <RevenueFlowCanvas active={true} />
        </div>

        <div className="relative z-10">
          <div className="flex items-center justify-between gap-4 mb-8">
            <AxacrmLogo />
            {onNavigateToHome && (
              <button
                type="button"
                onClick={onNavigateToHome}
                className="font-mono text-xs text-[#71717a] dark:text-[#8b949e] hover:text-[#3b82f6] dark:hover:text-[#3b82f6] flex items-center gap-1 bg-transparent border-none cursor-pointer transition-colors"
              >
                ← RETURN TO HOME
              </button>
            )}
          </div>

          <div className="inline-flex items-center gap-2 mb-3">
            <PixelIndicator active pulseColor="blue" />
            <span className="font-mono text-xs text-[#3b82f6] font-bold">
              / REVENUE COMMAND WORKSPACE
            </span>
          </div>

          <h1 className="text-3xl sm:text-4xl font-extrabold font-mono tracking-tight text-[#18181b] dark:text-white uppercase leading-tight mb-4">
            HIGH-VELOCITY SALES PIPELINES & CUSTOMER RELATIONSHIPS.
          </h1>

          <p className="text-xs sm:text-sm text-[#52525b] dark:text-[#8b949e] font-mono leading-relaxed max-w-md">
            Manage inbound leads, visual Kanban deals, multi-channel sequences,
            quotes, and billing from a single high-performance workspace.
          </p>
        </div>

        <div className="relative z-10 pt-8 border-t border-[#d1d1d1]/60 dark:border-[#21262d] space-y-3 font-mono text-xs text-[#52525b] dark:text-[#8b949e]">
          <div className="flex items-center gap-2">
            <PixelIndicator active pulseColor="emerald" />
            <span>Zero-Knowledge AXA PASS Credential Linking</span>
          </div>
          <div className="flex items-center gap-2">
            <PixelIndicator active pulseColor="blue" />
            <span>Visual Automated Sequences & Webhook Ingestion</span>
          </div>
          <div className="flex items-center gap-2">
            <PixelIndicator active pulseColor="emerald" />
            <span>75%+ Lower TCO vs Salesforce & HubSpot</span>
          </div>

          <div className="flex items-center gap-4 pt-3 text-[11px]">
            {onNavigateToPricing && (
              <button
                type="button"
                onClick={onNavigateToPricing}
                className="text-[#3b82f6] hover:underline bg-transparent border-none p-0 cursor-pointer"
              >
                View Pricing & TCO →
              </button>
            )}
            {onNavigateToDemo && (
              <button
                type="button"
                onClick={onNavigateToDemo}
                className="text-[#3b82f6] hover:underline bg-transparent border-none p-0 cursor-pointer"
              >
                Explore Sales Lab Demo →
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Right authentication form */}
      <section className="w-full md:w-1/2 flex items-center justify-center p-6 sm:p-12 relative">
        <div className="w-full max-w-md border border-[#d1d1d1] dark:border-[#21262d] bg-white dark:bg-[#161b22] p-8 sm:p-10 relative shadow-xl">
          <CornerBrackets stroke="#3b82f6" size={10} />

          <div className="flex items-center justify-between mb-6 pb-4 border-b border-[#e4e4e7] dark:border-[#21262d]">
            <div>
              <h2 className="text-xl font-bold font-mono text-[#18181b] dark:text-white">
                {mode === "setup" ? "CREATE WORKSPACE" : "SIGN IN TO TUNAXA"}
              </h2>
              <p className="font-mono text-xs text-[#71717a] dark:text-[#8b949e] mt-0.5">
                {mode === "setup"
                  ? "Initialize owner credentials"
                  : "Access your CRM revenue command"}
              </p>
            </div>
            <div className="w-9 h-9 border border-[#3b82f6]/40 bg-[#3b82f6]/10 text-[#3b82f6] font-mono font-bold text-xs flex items-center justify-center">
              CRM
            </div>
          </div>

          <form onSubmit={submit} className="space-y-4 font-mono text-xs">
            {mode === "setup" && (
              <div>
                <label className="block text-[#71717a] dark:text-[#8b949e] mb-1 font-bold">
                  YOUR NAME
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Alex Vance"
                  className="w-full p-2.5 border border-[#d1d1d1] dark:border-[#21262d] bg-[#f9fafb] dark:bg-[#0d1117] text-[#18181b] dark:text-white focus:outline-none focus:border-[#3b82f6]"
                  autoFocus
                />
              </div>
            )}

            <div>
              <label className="block text-[#71717a] dark:text-[#8b949e] mb-1 font-bold">
                EMAIL ADDRESS
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
                className="w-full p-2.5 border border-[#d1d1d1] dark:border-[#21262d] bg-[#f9fafb] dark:bg-[#0d1117] text-[#18181b] dark:text-white focus:outline-none focus:border-[#3b82f6]"
                autoFocus={mode === "login"}
              />
            </div>

            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="block text-[#71717a] dark:text-[#8b949e] font-bold">
                  PASSWORD
                </label>
                <button
                  type="button"
                  aria-label={show ? "Hide password" : "Show password"}
                  onClick={() => setShow((value) => !value)}
                  className="text-[#71717a] dark:text-[#8b949e] hover:text-[#18181b] dark:hover:text-white bg-transparent border-none cursor-pointer text-[11px]"
                >
                  {show ? "HIDE" : "SHOW"}
                </button>
              </div>
              <input
                type={show ? "text" : "password"}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Minimum 6 characters"
                className="w-full p-2.5 border border-[#d1d1d1] dark:border-[#21262d] bg-[#f9fafb] dark:bg-[#0d1117] text-[#18181b] dark:text-white focus:outline-none focus:border-[#3b82f6]"
              />
            </div>

            <div className="pt-2">
              <CutButton variant="primary" className="w-full" disabled={busy}>
                {busy
                  ? "AUTHENTICATING TELEMETRY…"
                  : mode === "setup"
                    ? "CREATE WORKSPACE →"
                    : "OPEN WORKSPACE →"}
              </CutButton>
            </div>

            {needsSetup !== true && (
              <div className="pt-4 text-center border-t border-[#e4e4e7] dark:border-[#21262d]">
                <button
                  type="button"
                  onClick={() =>
                    setMode((m) => (m === "login" ? "setup" : "login"))
                  }
                  className="text-[#71717a] dark:text-[#8b949e] hover:text-[#3b82f6] bg-transparent border-none cursor-pointer text-xs"
                >
                  {mode === "login"
                    ? "Need to create a new workspace? Set up here"
                    : "Already have a workspace? Sign in"}
                </button>
              </div>
            )}
            <button className="btn login-submit" type="submit" style={{ marginTop: 4 }} disabled={busy}>{busy
                ? "Please wait…"
                : mode === "setup"
                  ? "Create workspace"
                  : "Sign in"}{" "}
              <Icon name="arrowRight" />
            </button>
        </form>
        </div>
      </section>
    </main>
  );
}

function AppRoutes() {
  const { user, toast, logout } = useApp();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(
    localStorage.getItem("tunaxa.sidebar") === "1",
  );
  const [pageSize, setPageSize] = useState(getPageSize());
  const [mobile, setMobile] = useState(false);
  const [profile, setProfile] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [theme, setTheme] = useState(
    document.documentElement.classList.contains("dark"),
  );
  const [isEcosystemOpen, setIsEcosystemOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem("tunaxa.sidebar", collapsed ? "1" : "0");

    api(
      "/users/me/preferences",
      json("PUT", { sidebarCollapsed: collapsed }),
    ).catch(() => {});
  }, [collapsed]);
  useEffect(() => {
    setMobile(false);
    setProfile(false);
  }, [location.pathname]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        setQuickOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  function changePageSize(value: number) {
    setPageSize(value);
    savePageSize(value);
  }
  function toggleTheme() {
    const next = !theme;
    setTheme(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("tunaxa.theme", next ? "dark" : "light");

    api(
      "/users/me/preferences",
      json("PUT", { theme: next ? "dark" : "light" }),
    ).catch(() => {});
  }

  function toggleLanguage() {
    const current = i18n.language || "en";
    const next = current === "fr" ? "en" : "fr";
    i18n.changeLanguage(next);
    localStorage.setItem("tunaxa.language", next);
  }

  const refreshAll = () =>
    window.dispatchEvent(new CustomEvent("tunaxa:resource-changed"));
  const sseHandlers: SSEHandlers = {
    "record.created": (data) =>
      window.dispatchEvent(
        new CustomEvent("tunaxa:resource-changed", {
          detail: { resource: data.resource },
        }),
      ),
    "workflow.created": refreshAll,
    "workflow.updated": refreshAll,
    "workflow.deleted": refreshAll,
    "workflow.graph_saved": refreshAll,
    "sequence.enrolled": refreshAll,
    "sequence.ran": refreshAll,
    "form.submitted": refreshAll,
    "form.created": refreshAll,
    "form.updated": refreshAll,
    "form.deleted": refreshAll,
    "user.role.changed": refreshAll,
    "user.created": refreshAll,
    "user.deleted": refreshAll,
    "lifecycle.transitioned": refreshAll,
    "leadscoring.rules_changed": refreshAll,
    "leadscoring.recalculated": refreshAll,
    "webhook.created": refreshAll,
    "webhook.updated": refreshAll,
    "webhook.deleted": refreshAll,
    "webhook.received": refreshAll,
    "ticket.opened": refreshAll,
    "ticket.updated": refreshAll,
    "execution.processed": refreshAll,
  };
  useSSE(sseHandlers);

  return (
    <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      {/* Blueprint dot-grid overlay — fixed behind all content */}
      <div className="blueprint-grid-global" aria-hidden="true" />
      <div
        className={`mobile-overlay ${mobile ? "show" : ""}`}
        onClick={() => setMobile(false)}
      />
      <aside className={`sidebar ${mobile ? "mobile-open" : ""}`}>
        <div className="sidebar-logo">
          <button
            className="brand"
            onClick={() => navigate("/dashboard")}
            title="Tunaxa AXA CRM"
          >
            {collapsed ? (
              <div
                className="w-7 h-7 bg-black text-white dark:bg-white dark:text-black flex items-center justify-center font-mono font-black shrink-0"
                style={{
                  clipPath:
                    "polygon(3px 0%, 100% 0%, 100% calc(100% - 3px), calc(100% - 3px) 100%, 0% 100%, 0% 3px)",
                }}
              >
                <span className="text-xs">TX</span>
              </div>
            ) : (
              <AxacrmLogo size="sm" showTunaxaPrefix={true} />
            )}
          </button>
          <button
            className="collapse-btn"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <Icon name="arrowLeft" />
          </button>
        </div>
        <nav className="nav-scroll">
          {navGroups.map((group) => (
            <section className="nav-group" key={group.label}>
              <div className="nav-label">{t(group.label)}</div>
              {group.items.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  data-tooltip={t(item.label)}
                  className={({ isActive }) =>
                    `nav-link ${isActive ? "active" : ""}`
                  }
                >
                  <Icon name={item.icon} />
                  <span>{t(item.label)}</span>
                </NavLink>
              ))}
            </section>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="workspace-mini">
            <div
              className="w-7 h-7 bg-[#3b82f6] text-white flex items-center justify-center font-mono font-bold text-xs shrink-0"
              style={{
                clipPath:
                  "polygon(3px 0%, 100% 0%, 100% calc(100% - 3px), calc(100% - 3px) 100%, 0% 100%, 0% 3px)",
              }}
            >
              <span>TX</span>
            </div>
            <div>
              <b>Tunaxa CRM</b>
              <small>Enterprise Workspace</small>
            </div>
          </div>
        </div>
      </aside>
      <section className="workspace">
        <header className="topbar topbar-glass">
          <div className="topbar-left">
            <button
              className="icon-btn mobile-menu"
              aria-label="Open navigation menu"
              onClick={() => setMobile(true)}
              title="Open Navigation"
            >
              <Icon name="menu" />
            </button>
            <div className="crumb relative px-3 py-1 border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#121820]">
              <CornerBrackets stroke="#3b82f6" size={5} />
              <span>{t("nav.workspace")}</span>
              <b>
                {titles[location.pathname]
                  ? t(titles[location.pathname])
                  : "Tunaxa"}
              </b>
            </div>
          </div>
          <div className="topbar-right">
            <button
              className="search-button"
              onClick={() => setSearchOpen(true)}
            >
              <Icon name="search" />
              <span>Search everything…</span>
              <kbd>Ctrl K</kbd>
            </button>
            <CutButton
              variant="primary"
              size="sm"
              onClick={() => setQuickOpen(true)}
            >
              <div className="flex items-center gap-1.5 font-mono text-xs">
                <Icon name="plus" />
                <span>NEW</span>
              </div>
            </CutButton>
            <button
              className="icon-btn"
              onClick={() => setIsEcosystemOpen(true)}
              title="Tunaxa Ecosystem Apps"
              aria-label="Tunaxa Ecosystem Apps"
            >
              <LayoutGrid className="w-4 h-4 text-[#3b82f6]" />
            </button>
            <button
              className="icon-btn"
              onClick={toggleTheme}
              title={theme ? "Light Blueprint" : "Dark Cyber"}
            >
              {theme ? (
                <Sun className="w-4 h-4" />
              ) : (
                <Moon className="w-4 h-4" />
              )}
            </button>
            <button
              className="icon-btn notification-btn"
              aria-label="Notifications"
              onClick={() => toast("No new notifications")}
              title="Notifications"
            >
              <Icon name="bell" />
            </button>
            <div className="profile-wrap">
              <button
                className="profile-trigger"
                onClick={() => setProfile((value) => !value)}
              >
                <Avatar name={user?.name || "TX"} />
                <div>
                  <b>{user?.name}</b>
                  <small>{user?.role}</small>
                </div>
                <Icon name="chevronDown" />
              </button>
              {profile ? (
                <div className="profile-menu">
                  <div className="profile-menu-head">
                    <Avatar name={user?.name || "TX"} size={38} />
                    <div>
                      <b>{user?.name}</b>
                      <small>{user?.email}</small>
                    </div>
                  </div>
                  <button onClick={() => navigate("/settings")}>
                    <Icon name="settings" /> {t("nav.settings")}
                  </button>
                  <button onClick={toggleLanguage}>
                    <Icon name="globe" />{" "}
                    {(i18n.language || "en") === "fr" ? "English" : "Français"}
                  </button>
                  <button onClick={toggleTheme}>
                    {theme ? (
                      <Sun className="w-4 h-4" />
                    ) : (
                      <Moon className="w-4 h-4" />
                    )}{" "}
                    {theme ? "Light Blueprint" : "Dark Cyber"}
                  </button>
                  <hr />
                  <button className="danger-link" onClick={logout}>
                    <Icon name="logout" /> Sign out
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>
        <main className="content">
          <ErrorBoundary fallbackMessage="Something went wrong. Please reload.">
            <Routes>
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route
                path="/dashboard"
                element={
                  <ErrorBoundary
                    key={location.pathname}
                    fallbackMessage="Dashboard failed to load."
                  >
                    <DashboardPage />
                  </ErrorBoundary>
                }
              />
              <Route
                path="/leads/:id"
                element={
                  <RecordDetailPage
                    resource="leads"
                    fields={leadFields}
                    title={t("nav.leads")}
                  />
                }
              />
              <Route
                path="/contacts/:id"
                element={
                  <RecordDetailPage
                    resource="contacts"
                    fields={contactFields}
                    title={t("nav.contacts")}
                  />
                }
              />
              <Route
                path="/companies/:id"
                element={
                  <RecordDetailPage
                    resource="companies"
                    fields={[
                      { key: "name", label: "Company name" },
                      { key: "industry", label: "Industry" },
                      { key: "website", label: "Website" },
                      { key: "country", label: "Country" },
                      { key: "employees", label: "Employees", type: "number" },
                      { key: "owner", label: "Owner" },
                    ]}
                    title={t("nav.companies")}
                  />
                }
              />
              <Route
                path="/deals/:id"
                element={
                  <RecordDetailPage
                    resource="deals"
                    fields={[
                      { key: "title", label: "Deal name" },
                      { key: "company", label: "Company" },
                      { key: "value", label: "Value", type: "number" },
                      {
                        key: "stage",
                        label: "Stage",
                        type: "select",
                        options: stages.map((x) => x.id),
                      },
                      { key: "owner", label: "Owner" },
                      { key: "closeDate", label: "Close date", type: "date" },
                    ]}
                    title={t("nav.deals")}
                  />
                }
              />
              <Route
                path="/campaigns/:id"
                element={
                  <RecordDetailPage
                    resource="campaigns"
                    fields={campaignFields}
                    title={t("nav.campaigns")}
                  />
                }
              />
              <Route
                path="/email-lists/:id"
                element={
                  <RecordDetailPage
                    resource="emailLists"
                    fields={emailListFields}
                    title={t("nav.emailLists")}
                  />
                }
              />
              <Route
                path="/landing-pages/:id"
                element={
                  <RecordDetailPage
                    resource="landingPages"
                    fields={landingPageFields}
                    title={t("nav.landingPages")}
                  />
                }
              />
              <Route
                path="/products/:id"
                element={
                  <RecordDetailPage
                    resource="products"
                    fields={productFields}
                    title={t("nav.products")}
                  />
                }
              />
              <Route
                path="/orders/:id"
                element={
                  <RecordDetailPage
                    resource="orders"
                    fields={orderFields}
                    title={t("nav.orders")}
                  />
                }
              />
              <Route
                path="/invoices/:id"
                element={
                  <RecordDetailPage
                    resource="invoices"
                    fields={invoiceFields}
                    title={t("nav.invoices")}
                  />
                }
              />
              <Route
                path="/expenses/:id"
                element={
                  <RecordDetailPage
                    resource="expenses"
                    fields={expenseFields}
                    title={t("nav.expenses")}
                  />
                }
              />
              <Route
                path="/employees/:id"
                element={
                  <RecordDetailPage
                    resource="employees"
                    fields={employeeFields}
                    title={t("nav.employees")}
                  />
                }
              />
              <Route
                path="/leave/:id"
                element={
                  <RecordDetailPage
                    resource="leaveRequests"
                    fields={leaveFields}
                    title={t("nav.leave")}
                  />
                }
              />
              <Route
                path="/attendance/:id"
                element={
                  <RecordDetailPage
                    resource="attendance"
                    fields={attendanceFields}
                    title={t("nav.attendance")}
                  />
                }
              />
              <Route
                path="/leads"
                element={
                  <PeoplePage
                    resource="leads"
                    title={t("nav.leads")}
                    description="Capture and qualify new opportunities."
                    icon="lead"
                    fields={leadFields}
                  />
                }
              />
              <Route
                path="/contacts"
                element={
                  <ErrorBoundary
                    key={location.pathname}
                    fallbackMessage="Contacts failed to load."
                  >
                    <PeoplePage
                      resource="contacts"
                      title={t("nav.contacts")}
                      description="Customer and prospect contact records."
                      icon="contacts"
                      fields={contactFields}
                    />
                  </ErrorBoundary>
                }
              />
              <Route path="/companies" element={<CompaniesPage />} />
              <Route
                path="/pipeline"
                element={
                  <ErrorBoundary
                    key={location.pathname}
                    fallbackMessage="Pipeline failed to load."
                  >
                    <PipelinePage />
                  </ErrorBoundary>
                }
              />
              <Route path="/activities" element={<ActivitiesPage />} />
              <Route path="/tasks" element={<TasksPage />} />
              <Route path="/calendar" element={<CalendarPage />} />
              <Route path="/workflows" element={<WorkflowsPage />} />
              <Route path="/workflows/:id" element={<WorkflowDetailPage key={location.pathname} />} />
              <Route path="/calls" element={<CallsPage />} />
              <Route path="/recordings" element={<RecordingsPage />} />
              <Route path="/inbox" element={<InboxPage />} />
              <Route path="/sequences" element={<SequencesPage />} />
              <Route path="/webhooks" element={<WebhooksPage />} />
              <Route path="/campaigns" element={<CampaignsPage />} />
              <Route path="/email-lists" element={<EmailListsPage />} />
              <Route path="/landing-pages" element={<LandingPagesPage />} />
              <Route path="/forms" element={<FormsPage />} />
              <Route path="/products" element={<ProductsPage />} />
              <Route path="/orders" element={<OrdersPage />} />
              <Route path="/finance" element={<FinancePage />} />
              <Route path="/invoices" element={<InvoicesPage />} />
              <Route path="/expenses" element={<ExpensesPage />} />
              <Route path="/forecast" element={<ForecastPage />} />
              <Route path="/employees" element={<EmployeesPage />} />
              <Route path="/leave" element={<LeavePage />} />
              <Route path="/attendance" element={<AttendancePage />} />
              <Route
                path="/marketing-emails"
                element={<MarketingEmailsPage />}
              />
              <Route
                path="/marketing-emails/:id"
                element={
                  <RecordDetailPage
                    resource="marketingEmails"
                    fields={marketingEmailFields}
                    title={t("nav.marketingEmails")}
                  />
                }
              />
              <Route path="/events" element={<EventsPage />} />
              <Route
                path="/events/:id"
                element={
                  <RecordDetailPage
                    resource="marketingEvents"
                    fields={marketingEventFields}
                    title={t("nav.events")}
                  />
                }
              />
              <Route path="/quotes" element={<QuotesPage />} />
              <Route
                path="/quotes/:id"
                element={
                  <RecordDetailPage
                    resource="quotes"
                    fields={quoteFields}
                    title={t("nav.quotes")}
                  />
                }
              />
              <Route path="/contracts" element={<ContractsPage />} />
              <Route
                path="/contracts/:id"
                element={
                  <RecordDetailPage
                    resource="contracts"
                    fields={contractFields}
                    title={t("nav.contracts")}
                  />
                }
              />
              <Route path="/surveys" element={<SurveysPage />} />
              <Route
                path="/surveys/:id"
                element={
                  <RecordDetailPage
                    resource="surveys"
                    fields={surveyFields}
                    title={t("nav.surveys")}
                  />
                }
              />
              <Route
                path="/survey-responses"
                element={<SurveyResponsesPage />}
              />
              <Route
                path="/survey-responses/:id"
                element={
                  <RecordDetailPage
                    resource="surveyResponses"
                    fields={surveyResponseFields}
                    title={t("nav.surveyResponses")}
                  />
                }
              />
              <Route path="/goals" element={<GoalsPage />} />
              <Route
                path="/goals/:id"
                element={
                  <RecordDetailPage
                    resource="goals"
                    fields={goalFields}
                    title={t("nav.goals")}
                  />
                }
              />
              <Route path="/duplicates" element={<DuplicatesPage />} />
              <Route path="/portal" element={<PortalPage />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="/audit" element={<AuditPage />} />
              <Route path="/team" element={<TeamPage />} />
              <Route path="/fields" element={<FieldsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </ErrorBoundary>
        </main>
      </section>
      {quickOpen ? <QuickCreate onClose={() => setQuickOpen(false)} /> : null}
      {searchOpen ? (
        <GlobalSearch onClose={() => setSearchOpen(false)} />
      ) : null}
      <EcosystemMenu
        isOpen={isEcosystemOpen}
        onClose={() => setIsEcosystemOpen(false)}
      />
    </div>
  );
}
function QuickCreate({ onClose }: { onClose: () => void }) {
  const { toast } = useApp();
  const [type, setType] = useState("leads");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const map: Record<string, string> = {
    leads: "Lead",
    contacts: "Contact",
    companies: "Company",
    deals: "Deal",
    tasks: "Task",
    activities: "Activity",
  };

  async function save() {
    if (!title.trim()) return toast("Enter a name or title", "error");
    setBusy(true);
    try {
      const data =
        type === "companies"
          ? { name: title.trim() }
          : type === "deals"
            ? { title: title.trim(), stage: "new", value: 0 }
            : type === "tasks"
              ? { title: title.trim(), status: "Open", priority: "Medium" }
              : type === "activities"
                ? { title: title.trim(), type: "Note" }
                : { name: title.trim() };
      await api(`/${type}`, json("POST", data));
      window.dispatchEvent(
        new CustomEvent("tunaxa:resource-changed", {
          detail: { resource: type },
        }),
      );
      toast(`${map[type]} created`);
      onClose();
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title="Create record"
      subtitle="Add a new CRM record without leaving your current page."
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? "Creating…" : `Create ${map[type]}`}
          </button>
        </>
      }
    >
      <div className="drawer-section-block">
        <span className="drawer-label">Record type</span>
        <div className="record-type-grid">
          {Object.entries(map).map(([key, label]) => (
            <button
              type="button"
              key={key}
              className={type === key ? "active" : ""}
              onClick={() => setType(key)}
            >
              <Icon
                name={
                  key === "deals"
                    ? "pipeline"
                    : key === "tasks"
                      ? "tasks"
                      : key === "activities"
                        ? "activity"
                        : key === "companies"
                          ? "companies"
                          : key === "contacts"
                            ? "contacts"
                            : "lead"
                }
              />
              {label}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        <span>Name / title</span>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder={`Enter ${map[type].toLowerCase()} name`}
        />
      </label>
    </Drawer>
  );
}

function GlobalSearch({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Row[]>([]);
  useEffect(() => {
    const timer = window.setTimeout(
      () =>
        q.trim()
          ? api<Row[]>(`/search?q=${encodeURIComponent(q)}`).then(setResults)
          : setResults([]),
      180,
    );
    return () => window.clearTimeout(timer);
  }, [q]);
  return (
    <div className="search-overlay" onMouseDown={onClose}>
      <div className="global-search" onMouseDown={(e) => e.stopPropagation()}>
        <div className="global-search-input">
          <Icon name="search" />
          <input
            autoFocus
            aria-label="Search workspace"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search leads, contacts, deals, tasks..."
          />
          <button
            className="icon-btn tiny"
            aria-label="Close search"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="search-results">
          {!q ? (
            <Empty
              icon="search"
              title="Search your workspace"
              text="Start typing to search stored CRM records."
            />
          ) : results.length ? (
            results.map((item) => (
              <button
                key={`${item.type}-${item.id}`}
                onClick={() => {
                  navigate(item.route);
                  onClose();
                }}
              >
                <span>
                  <Icon
                    name={
                      item.type === "Deal"
                        ? "pipeline"
                        : item.type === "Company"
                          ? "companies"
                          : item.type === "Contact"
                            ? "contacts"
                            : item.type === "Task"
                              ? "tasks"
                              : item.type === "Recording"
                                ? "recording"
                                : "lead"
                    }
                  />
                </span>
                <div>
                  <b>{item.name}</b>
                  <small>
                    {item.type}
                    {item.detail ? ` · ${item.detail}` : ""}
                  </small>
                </div>
                <Icon name="arrowRight" />
              </button>
            ))
          ) : (
            <Empty
              icon="search"
              title="No matches"
              text="No results found for your search."
            />
          )}
        </div>git
      </div>
    </div>
  );
}

function DashboardPage() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<any>(null);
  useEffect(() => {
    const load = () => api("/dashboard").then(setStats);
    load();
    window.addEventListener("tunaxa:resource-changed", load);
    return () => window.removeEventListener("tunaxa:resource-changed", load);
  }, []);
  const cards = [
    [
      "Pipeline value",
      money(stats?.pipeline || 0),
      "Open deal value",
      "money",
      "blue",
    ],
    ["Won revenue", money(stats?.won || 0), "Closed won", "trend", "green"],
    [
      "Qualified leads",
      String(stats?.qualified || 0),
      "Ready for pipeline",
      "lead",
      "purple",
    ],
    [
      "Connected calls",
      String(stats?.connected || 0),
      "Logged conversations",
      "phone",
      "amber",
    ],
  ];
  const recent = stats?.recent || [];

  return (
    <div className="page">
      <PageHeader
        title="Dashboard"
        description="A live view of your sales workspace."
      >
        <button className="btn primary" onClick={() => navigate("/pipeline")}>
          <Icon name="pipeline" /> Open pipeline
        </button>
      </PageHeader>
      <div className="stats-grid">
        {cards.map((card) => (
          <div className="stat-card hover-crm-card relative" key={card[0]}>
            <CornerBrackets stroke="#3b82f6" size="sm" />
            <div className={`stat-icon tone-${card[4]}`}>
              <Icon name={card[3]} />
            </div>
            <div>
              <small>{card[0]}</small>
              <strong>{card[1]}</strong>
              <span>{card[2]}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="dashboard-grid">
        <section className="surface revenue-card">
          <div className="section-head">
            <div>
              <h2>Workspace totals</h2>
              <p>Everything saved in your Tunaxa workspace</p>
            </div>
            <button
              className="btn secondary compact"
              onClick={() => navigate("/reports")}
            >
              View reports
            </button>
          </div>
          <div className="record-count-grid">
            {[
              ["Leads", stats?.leads, "lead", "/leads"],
              ["Contacts", stats?.contacts, "contacts", "/contacts"],
              ["Companies", stats?.companies, "companies", "/companies"],
              ["Deals", stats?.deals, "pipeline", "/pipeline"],
              ["Tasks", stats?.tasks, "tasks", "/tasks"],
            ].map(([label, count, icon, path]) => (
              <button
                key={String(label)}
                className="record-count"
                onClick={() => navigate(String(path))}
              >
                <Icon name={String(icon)} />
                <b>{count || 0}</b>
                <span>{label}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="surface activities-widget">
          <div className="section-head">
            <div>
              <h2>Recent activity</h2>
              <p>Latest work across the CRM</p>
            </div>
          </div>
          {recent.length ? (
            <div className="recent-list">
              {recent.slice(0, 6).map((item: Row) => (
                <button
                  key={`${item.kind}-${item.id}`}
                  onClick={() => navigate(item.route)}
                >
                  <span className="recent-icon">
                    <Icon name={item.icon} />
                  </span>
                  <div>
                    <b>{item.title}</b>
                    <small>{item.meta}</small>
                  </div>
                  <time>{new Date(item.createdAt).toLocaleString()}</time>
                </button>
              ))}
            </div>
          ) : (
            <Empty
              icon="activity"
              title="No activity yet"
              text="Your latest calls, tasks and activities will appear here automatically."
              action={
                <button
                  className="btn primary compact"
                  onClick={() => navigate("/leads")}
                >
                  Add a lead
                </button>
              }
            />
          )}
        </section>
      </div>
    </div>
  );
}

type FieldSpec = {
  key: string;
  label: string;
  type?: string;
  options?: string[];
  required?: boolean;
  placeholder?: string;
};
export const leadFields: FieldSpec[] = [
  { key: "name", label: "Lead name", required: true },
  { key: "company", label: "Company" },
  { key: "email", label: "Email", type: "email" },
  { key: "phone", label: "Phone" },
  { key: "source", label: "Source" },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: ["New", "Contacted", "Qualified", "Nurture", "Lost"],
  },
  { key: "owner", label: "Owner" },
  
  { key: "value", label: "Estimated value", type: "number" },
];
export const contactFields: FieldSpec[] = [
  { key: "name", label: "Contact name", required: true },
  { key: "role", label: "Job title" },
  { key: "company", label: "Company" },
  { key: "email", label: "Email", type: "email" },
  { key: "phone", label: "Phone" },
  { key: "owner", label: "Owner" },
];

const campaignFields: FieldSpec[] = [
  { key: "name", label: "Campaign name", required: true },
  {
    key: "channel",
    label: "Channel",
    type: "select",
    options: ["Email", "SMS", "Social", "Multi-channel"],
  },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: ["Draft", "Active", "Paused", "Completed"],
  },
  { key: "target", label: "Target audience", type: "number" },
  { key: "reached", label: "Reached", type: "number" },
  { key: "leads", label: "Leads generated", type: "number" },
  { key: "startDate", label: "Start date", type: "date" },
  { key: "endDate", label: "End date", type: "date" },
  { key: "description", label: "Description", type: "textarea" },
];
const emailListFields: FieldSpec[] = [
  { key: "name", label: "List name", required: true },
  { key: "subscribers", label: "Subscribers", type: "number" },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: ["Draft", "Active", "Archived"],
  },
  { key: "description", label: "Description", type: "textarea" },
];
const landingPageFields: FieldSpec[] = [
  { key: "name", label: "Page name", required: true },
  { key: "slug", label: "Slug" },
  { key: "url", label: "URL" },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: ["Draft", "Published", "Archived"],
  },
  { key: "views", label: "Views", type: "number" },
  { key: "conversions", label: "Conversions", type: "number" },
];
const productFields: FieldSpec[] = [
  { key: "name", label: "Product name", required: true },
  { key: "sku", label: "SKU" },
  { key: "category", label: "Category" },
  { key: "price", label: "Price", type: "number" },
  { key: "cost", label: "Cost", type: "number" },
  { key: "stock", label: "Stock", type: "number" },
  { key: "minStock", label: "Low-stock threshold", type: "number" },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: ["Active", "Archived"],
  },
];
const orderFields: FieldSpec[] = [
  { key: "orderNumber", label: "Order number", required: true },
  { key: "customer", label: "Customer" },
  { key: "email", label: "Customer email", type: "email" },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: ["Draft", "Pending", "Paid", "Shipped", "Delivered", "Cancelled"],
  },
  { key: "items", label: "Line items (one per line)", type: "textarea" },
  { key: "subtotal", label: "Subtotal", type: "number" },
  { key: "tax", label: "Tax", type: "number" },
  { key: "shipping", label: "Shipping", type: "number" },
  { key: "total", label: "Total", type: "number" },
  { key: "date", label: "Order date", type: "date" },
];
const invoiceFields: FieldSpec[] = [
  { key: "number", label: "Invoice number", required: true },
  { key: "customerName", label: "Customer name" },
  { key: "customerEmail", label: "Customer email", type: "email" },
  { key: "amount", label: "Amount", type: "number" },
  { key: "tax", label: "Tax", type: "number" },
  { key: "issueDate", label: "Issue date", type: "date" },
  { key: "dueDate", label: "Due date", type: "date" },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: ["Draft", "Pending", "Paid", "Overdue", "Cancelled"],
  },
  { key: "notes", label: "Notes", type: "textarea" },
];
const expenseFields: FieldSpec[] = [
  { key: "title", label: "Expense title", required: true },
  {
    key: "category",
    label: "Category",
    type: "select",
    options: ["Software", "Travel", "Marketing", "Office", "Salaries", "Other"],
  },
  { key: "amount", label: "Amount", type: "number" },
  { key: "vendor", label: "Vendor" },
  { key: "date", label: "Date", type: "date" },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: ["Pending", "Approved", "Reimbursed"],
  },
  { key: "notes", label: "Notes", type: "textarea" },
];
const employeeFields: FieldSpec[] = [
  { key: "avatar", label: "Photo", type: "photo" },
  { key: "name", label: "Full name", required: true },
  { key: "email", label: "Email", type: "email" },
  { key: "department", label: "Department" },
  { key: "title", label: "Job title" },
  { key: "manager", label: "Manager" },
  { key: "salary", label: "Salary", type: "number" },
  { key: "startDate", label: "Start date", type: "date" },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: ["Onboarding", "Active", "On leave", "Terminated"],
  },
];
const leaveFields: FieldSpec[] = [
  { key: "employee", label: "Employee", required: true },
  {
    key: "type",
    label: "Type",
    type: "select",
    options: ["Vacation", "Sick", "Parental", "Unpaid"],
  },
  { key: "startDate", label: "Start date", type: "date" },
  { key: "endDate", label: "End date", type: "date" },
  { key: "days", label: "Days", type: "number" },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: ["Pending", "Approved", "Rejected"],
  },
  { key: "reason", label: "Reason", type: "textarea" },
];
const attendanceFields: FieldSpec[] = [
  { key: "employee", label: "Employee", required: true },
  { key: "date", label: "Date", type: "date" },
  { key: "checkIn", label: "Check-in" },
  { key: "checkOut", label: "Check-out" },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: ["Present", "Late", "Absent", "On leave", "Remote"],
  },
  { key: "notes", label: "Notes", type: "textarea" },
];
const quoteFields: FieldSpec[] = [
  { key: "number", label: "Quote number", required: true },
  { key: "customer", label: "Customer / deal" },
  { key: "subtotal", label: "Subtotal", type: "number" },
  { key: "discount", label: "Discount (%)", type: "number" },
  { key: "tax", label: "Tax (%)", type: "number" },
  { key: "total", label: "Total", type: "number" },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: ["Draft", "Sent", "Accepted", "Declined", "Expired"],
  },
  { key: "expiryDate", label: "Expiry date", type: "date" },
];
const contractFields: FieldSpec[] = [
  { key: "name", label: "Contract name", required: true },
  { key: "customer", label: "Customer" },
  { key: "value", label: "Value", type: "number" },
  { key: "mrr", label: "Monthly recurring", type: "number" },
  {
    key: "billingFrequency",
    label: "Billing frequency",
    type: "select",
    options: ["Monthly", "Quarterly", "Annual"],
  },
  { key: "startDate", label: "Start date", type: "date" },
  { key: "endDate", label: "End date", type: "date" },
  { key: "autoRenew", label: "Auto-renew", type: "checkbox" },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: ["Active", "Expiring", "Expired", "Cancelled", "Draft"],
  },
];
const marketingEmailFields: FieldSpec[] = [
  { key: "name", label: "Email name", required: true },
  { key: "subject", label: "Subject line" },
  { key: "list", label: "Audience list" },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: ["Draft", "Scheduled", "Sent", "Archived"],
  },
  { key: "recipients", label: "Recipients", type: "number" },
  { key: "opens", label: "Opens", type: "number" },
  { key: "clicks", label: "Clicks", type: "number" },
  { key: "conversions", label: "Conversions", type: "number" },
  { key: "sendDate", label: "Send date", type: "date" },
];
const marketingEventFields: FieldSpec[] = [
  { key: "name", label: "Event name", required: true },
  {
    key: "type",
    label: "Type",
    type: "select",
    options: ["Webinar", "Conference", "Workshop", "Virtual", "In-person"],
  },
  { key: "location", label: "Location / link" },
  { key: "startDate", label: "Start date", type: "date" },
  { key: "endDate", label: "End date", type: "date" },
  { key: "capacity", label: "Capacity", type: "number" },
  { key: "registrations", label: "Registrations", type: "number" },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: ["Planned", "Upcoming", "Live", "Completed", "Cancelled"],
  },
];
const goalFields: FieldSpec[] = [
  { key: "name", label: "Goal name", required: true },
  {
    key: "metric",
    label: "Metric",
    type: "select",
    options: [
      "Revenue",
      "Calls made",
      "Deals closed",
      "Tickets resolved",
      "Leads generated",
    ],
  },
  { key: "owner", label: "Owner / team" },
  {
    key: "period",
    label: "Period",
    type: "select",
    options: ["Monthly", "Quarterly", "Yearly"],
  },
  { key: "target", label: "Target", type: "number" },
  { key: "current", label: "Current value", type: "number" },
  { key: "startDate", label: "Start date", type: "date" },
  { key: "endDate", label: "End date", type: "date" },
];
const surveyFields: FieldSpec[] = [
  { key: "name", label: "Survey name", required: true },
  {
    key: "type",
    label: "Type",
    type: "select",
    options: ["NPS", "CSAT", "CES"],
  },
  { key: "question", label: "Question", type: "textarea" },
  { key: "audience", label: "Audience" },
  { key: "targetScore", label: "Target score", type: "number" },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: ["Draft", "Active", "Closed"],
  },
];
const surveyResponseFields: FieldSpec[] = [
  { key: "survey", label: "Survey", required: true },
  { key: "respondent", label: "Respondent email" },
  { key: "score", label: "Score", type: "number" },
  { key: "comment", label: "Comment", type: "textarea" },
  { key: "date", label: "Date answered", type: "date" },
];

const moneyKeys = new Set([
  "value",
  "price",
  "cost",
  "amount",
  "total",
  "subtotal",
  "tax",
  "shipping",
  "salary",
  "target",
  "reached",
]);
const showMoney = (key: string) => moneyKeys.has(key);
type BadgeTone = "neutral" | "blue" | "green" | "amber" | "red" | "purple";

function CrudTablePage({
  resource,
  title,
  description,
  icon,
  fields,
  columns,
  nameKey = "name",
  statusField,
  synopsis,
  primary,
  statusTone,
  moneyColumn,
  extraColumn,
  renderEditor,
}: {
  resource: string;
  title: string;
  description: string;
  icon: string;
  fields: FieldSpec[];
  columns?: FieldSpec[];
  nameKey?: string;
  statusField?: string;
  synopsis?: (row: Row) => string;
  primary?: (row: Row) => string;
  statusTone?: (value?: string) => BadgeTone;
  moneyColumn?: string[];
  extraColumn?: { title: string; render: (row: Row) => ReactNode };
  renderEditor?: (props: {
    title: string;
    initial: Row | Record<string, any>;
    onClose: () => void;
    onSave: (data: Record<string, any>) => Promise<void>;
  }) => ReactNode;
}) {
  const { items, loading, load, create, update, remove } =
    useResource<Row>(resource);
  const { toast } = useApp();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
const [pageSize, setPageSize] = useState(getPageSize());
const [page, setPage] = useState(1);
const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const cols = columns || fields;
  const mCols = new Set(moneyColumn || cols.map((c) => c.key));
  const singular = title.slice(0, -1).toLowerCase();
  const nameOf = (row: Row) =>
    primary ? primary(row) : String(row[nameKey] || "Untitled");
  const toneOf =
    statusTone ||
    ((value?: string): BadgeTone =>
      value === "Active" ||
      value === "Paid" ||
      value === "Approved" ||
      value === "Published" ||
      value === "Delivered" ||
      value === "Present" ||
      value === "Completed"
        ? "green"
        : value === "Lost" ||
            value === "Cancelled" ||
            value === "Rejected" ||
            value === "Absent" ||
            value === "Overdue" ||
            value === "Terminated"
          ? "red"
          : "blue");
const filteredRows = items.filter(
  (row) =>
    !query || JSON.stringify(row).toLowerCase().includes(query.toLowerCase()),
);

const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));

const rows = filteredRows.slice(
  (page - 1) * pageSize,
  page * pageSize,
);
useEffect(() => {
  setPage(1);
}, [query, pageSize, resource]);

function changePageSize(value: number) {
  setPageSize(value);
  setPage(1);
  savePageSize(value);
}

  async function importCsv(file: File) {
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) return toast("CSV has no rows", "error");
      const headers = lines[0]
        .split(",")
        .map((x) => x.trim().replace(/^"|"$/g, ""));
      const records = lines.slice(1).map((line) => {
        const values = line
          .split(",")
          .map((x) => x.trim().replace(/^"|"$/g, ""));
        return Object.fromEntries(
          headers.map((key, index) => [key, values[index] || ""]),
        );
      });
      await api(`/${resource}/batch`, json("POST", records));
      await load();
      toast(`${records.length} rows imported`);
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  }
  function exportCsv() {
    if (!items.length) return toast("Nothing to export", "error");
    const keys = fields.map((x) => x.key);
    const csv = [
      keys.join(","),
      ...items.map((row) =>
        keys
          .map((key) => `"${String(row[key] || "").replace(/"/g, '""')}"`)
          .join(","),
      ),
    ].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${resource}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function cell(row: Row, field: FieldSpec) {
    const value = row[field.key];
    if (value === undefined || value === null || value === "") return "—";
    if (showMoney(field.key) && mCols.has(field.key))
      return money(Number(value));
    if (field.type === "date") return String(value).slice(0, 10);
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  }

    return (
    <div className="page">
      <PageHeader title={title} description={description}>
        <input
          ref={inputRef}
          hidden
          type="file"
          accept=".csv,text/csv"
          onChange={(e) =>
            e.target.files?.[0] && importCsv(e.target.files[0])
          }
        />

        <button
          className="btn secondary"
          onClick={() => inputRef.current?.click()}
        >
          <Icon name="upload" /> Import
        </button>

        <button
          className="btn secondary"
          disabled={!items.length}
          onClick={exportCsv}
        >
          <Icon name="download" /> Export
        </button>

        <button
          className="btn primary"
          onClick={() => setEdit(null)}
        >
          <Icon name="plus" /> Add {singular}
        </button>
      </PageHeader>

      <section className="surface table-surface">
        <div className="table-toolbar">
          <div className="header-search">
            <Icon name="search" />

            <input
              aria-label={`Search ${title.toLowerCase()}`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${title.toLowerCase()}`}
            />
          </div>

          <span className="table-count">
            {filteredRows.length} total
          </span>

          <select
            value={pageSize}
            onChange={(e) =>
              changePageSize(Number(e.target.value))
            }
            className="table-page-size"
            aria-label="Rows per page"
          >
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </div>

        {loading ? (
          <div className="table-loading">Loading…</div>
        ) : rows.length ? (
          <>
            <table>
              <thead>
                <tr>
                  <th>{cols[0]?.label || "Name"}</th>

                  {cols.slice(1).map((c) => (
                    <th key={c.key}>{c.label}</th>
                  ))}

                  {extraColumn ? (
                    <th>{extraColumn.title}</th>
                  ) : null}

                  <th />
                </tr>
              </thead>

              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    {cols.map((c, i) =>
                      i === 0 ? (
                        <td key={c.key}>
                          <button
                            className="person-cell person-link"
                            onClick={() =>
                              navigate(`/${resource}/${row.id}`)
                            }
                          >
                            <Avatar
                              name={nameOf(row)}
                              src={row.avatar || row.logo}
                            />

                            <div>
                              <b>{nameOf(row)}</b>

                              {synopsis ? (
                                <small>{synopsis(row)}</small>
                              ) : null}
                            </div>
                          </button>
                        </td>
                      ) : c.key === statusField ? (
                        <td key={c.key}>
                          <Badge
                            tone={toneOf(row[statusField!])}
                          >
                            {row[statusField!] || "—"}
                          </Badge>
                        </td>
                      ) : (
                        <td key={c.key}>{cell(row, c)}</td>
                      ),
                    )}

                    {extraColumn ? (
                      <td>{extraColumn.render(row)}</td>
                    ) : null}

                    <td>
                      <div className="row-actions">
                        <button
                          className="icon-btn tiny"
                          onClick={() => setEdit(row)}
                          title="Edit"
                        >
                          <Icon name="edit" />
                          <Avatar
                            name={nameOf(row)}
                            src={row.avatar || row.logo}
                          />
                          <div>
                           <div className="lead-name-row">
  <b>{nameOf(row)}</b>
  {resource === "leads" &&
  typeof row.leadScore === "number" ? (
  <span title="AI Score — based on engagement signals">
  <Badge
    tone={
      row.leadScore <= 40
        ? "red"
        : row.leadScore <= 70
          ? "amber"
          : "green"
    }
  >
    {row.leadScore}
  </Badge>
</span>
  ) : null}
</div>
{synopsis ? <small>{synopsis(row)}</small> : null}
                          </div>
                        </button>

                        <button
                          className="icon-btn tiny danger-link"
                          onClick={() =>
                            confirm(
                              `Delete ${nameOf(row)}?`,
                            ) && remove(row.id)
                          }
                          title="Delete"
                        >
                          <Icon name="trash" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="table-pagination">
              <button
                className="btn secondary compact"
                disabled={page <= 1}
                onClick={() =>
                  setPage((current) => current - 1)
                }
              >
                Previous
              </button>

              <span>
                Page {page} of {totalPages}
              </span>

              <button
                className="btn secondary compact"
                disabled={page >= totalPages}
                onClick={() =>
                  setPage((current) => current + 1)
                }
              >
                Next
              </button>
            </div>
          </>
        ) : (
          <Empty
            icon={icon}
            title={
              query
                ? `No ${title.toLowerCase()} found`
                : `No ${title.toLowerCase()} yet`
            }
            text={
              query
                ? "Try another search term."
                : `Add your first ${singular} or import a CSV file.`
            }
            action={
              !query ? (
                <button
                  className="btn primary compact"
                  onClick={() => setEdit(null)}
                >
                  Add {singular}
                </button>
              ) : undefined
            }
          />
        )}
      </section>

      {edit !== undefined ? (
        renderEditor ? (
          renderEditor({
            title: `${edit ? "Edit" : "Add"} ${singular}`,
            initial: edit || {},
            onClose: () => setEdit(undefined),
            onSave: async (data) => {
              edit ? await update(edit.id, data) : await create(data);
              setEdit(undefined);
            },
          })
        ) : (
          <RecordForm
            title={`${edit ? "Edit" : "Add"} ${singular}`}
            fields={fields}
            initial={edit || {}}
            onClose={() => setEdit(undefined)}
            onSave={async (data) => {
              edit ? await update(edit.id, data) : await create(data);
              setEdit(undefined);
            }}
          />
        )
      ) : null}
    </div>
  );
}

function useSchema(object: string): FieldSpec[] {
  const [custom, setCustom] = useState<FieldSpec[]>([]);
  useEffect(() => {
    api<{ fields: FieldSpec[] }>(`/schema/${object}`)
      .then((schema) => setCustom(schema.fields))
      .catch(() => {});
  }, [object]);
  return custom;
}

async function downloadResourceCsv(resource: string) {
  const headers = new Headers();
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`/api/${resource}/export.csv`, { headers });
  if (!response.ok) throw new Error(`Export failed (${response.status})`);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = `${resource}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function PeoplePage({
  resource,
  title,
  description,
  icon,
  fields,
}: {
  resource: string;
  title: string;
  description: string;
  icon: string;
  fields: FieldSpec[];
}) {
  const { items, loading, load, create, update, remove } =
    useResource<Row>(resource);
  const { toast } = useApp();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [pageSize, setPageSize] = useState(getPageSize());
  const [page, setPage] = useState(1);
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const custom = useSchema(resource);
  const allFields = [
    ...fields,
    ...custom.filter((field) => !fields.some((base) => base.key === field.key)),
  ];
  const peopleFields: FieldSpec[] = [
    { key: "avatar", label: "Photo", type: "photo" },
    ...allFields,
  ];
  const cols = allFields;
  const mCols = new Set(cols.map((field) => field.key));
  const singular = title.slice(0, -1).toLowerCase();
  const nameOf = (row: Row) => String(row.name || row.title || "Untitled");
  const synopsis = (row: Row) => row.company || row.role || "";
  const statusField = "status";
  const toneOf = (value?: string): BadgeTone => value === "Active" ? "green" : "blue";
const filteredRows = items.filter(
  (row) =>
    !query ||
    JSON.stringify(row).toLowerCase().includes(query.toLowerCase()),
);

const totalPages = Math.max(
  1,
  Math.ceil(filteredRows.length / pageSize),
);

const rows = filteredRows.slice(
  (page - 1) * pageSize,
  page * pageSize,
);

useEffect(() => {
  setPage(1);
}, [query, pageSize, resource]);

function changePageSize(value: number) {
  setPageSize(value);
  setPage(1);
  savePageSize(value);
}
  async function importCsv(file: File) {
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) return toast("CSV has no rows", "error");
      const headers = lines[0]
        .split(",")
        .map((x) => x.trim().replace(/^"|"$/g, ""));
      const records = lines.slice(1).map((line) => {
        const values = line
          .split(",")
          .map((x) => x.trim().replace(/^"|"$/g, ""));
        return Object.fromEntries(
          headers.map((key, index) => [key, values[index] || ""]),
        );
      });
      await api(`/${resource}/batch`, json("POST", records));
      await load();
      toast(`${records.length} rows imported`);
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function exportCsv() {
    try {
      await downloadResourceCsv(resource);
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  function cell(row: Row, field: FieldSpec) {
    const value = row[field.key];
    if (value === undefined || value === null || value === "") return "—";
    if (showMoney(field.key) && mCols.has(field.key))
      return money(Number(value));
    if (field.type === "date") return String(value).slice(0, 10);
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  }

  return (
    <div className="page">
      <PageHeader title={title} description={description}>
        <input
          ref={inputRef}
          hidden
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])}
        />
        <button
          className="btn secondary"
          onClick={() => inputRef.current?.click()}
        >
          <Icon name="upload" /> Import
        </button>
        <button className="btn secondary" onClick={exportCsv}>
          <Icon name="download" /> Export CSV
        </button>
        <button className="btn primary" onClick={() => setEdit(null)}>
          <Icon name="plus" /> Add {singular}
        </button>
      </PageHeader>
      <section className="surface table-surface">
        <div className="table-toolbar">
          <div className="header-search">
            <Icon name="search" />
            <input
              aria-label={`Search ${title.toLowerCase()}`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${title.toLowerCase()}`}
            />
          </div>
<span className="table-count">
  {filteredRows.length} total
</span>

<select
  value={pageSize}
  onChange={(e) => changePageSize(Number(e.target.value))}
  className="table-page-size"
  aria-label="Rows per page"
>
  <option value={10}>10</option>
  <option value={25}>25</option>
  <option value={50}>50</option>
  <option value={100}>100</option>
</select>        </div>
        {loading ? (
          <div className="table-loading">Loading…</div>
        ) : rows.length ? (
          <table>
            <thead>
              <tr>
                <th>{cols[0]?.label || "Name"}</th>
                {cols.slice(1).map((c) => (
                  <th key={c.key}>{c.label}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  {cols.map((c, i) =>
                    i === 0 ? (
                      <td key={c.key}>
                        <button
                          className="person-cell person-link"
                          onClick={() => navigate(`/${resource}/${row.id}`)}
                        >
                          <Avatar
                            name={nameOf(row)}
                            src={row.avatar || row.logo}
                          />
                          <div>
                            <b>{nameOf(row)}</b>
                            {synopsis ? <small>{synopsis(row)}</small> : null}
                          </div>
                        </button>
                      </td>
                    ) : c.key === statusField ? (
                      <td key={c.key}>
                        <Badge tone={toneOf(row[statusField!])}>
                          {row[statusField!] || "—"}
                        </Badge>
                      </td>
                    ) : (
                      <td key={c.key}>{cell(row, c)}</td>
                    ),
                  )}
                  <td>
                    <div className="row-actions">
                      <button
                        className="icon-btn tiny"
                        onClick={() => setEdit(row)}
                        title="Edit"
                      >
                        <Icon name="edit" />
                      </button>
                      <button
                        className="icon-btn tiny danger-link"
                        onClick={() =>
                          confirm(`Delete ${nameOf(row)}?`) && remove(row.id)
                        }
                        title="Delete"
                      >
                        <Icon name="trash" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty
            icon={icon}
            title={
              query
                ? `No ${title.toLowerCase()} found`
                : `No ${title.toLowerCase()} yet`
            }
            text={
              query
                ? "Try another search term."
                : `Add your first ${singular} or import a CSV file.`
            }
            action={
              !query ? (
                <button
                  className="btn primary compact"
                  onClick={() => setEdit(null)}
                >
                  Add {singular}
                </button>
              ) : undefined
            }
          />
        )}
      </section>
      {edit !== undefined ? (
        <RecordForm
          title={`${edit ? "Edit" : "Add"} ${singular}`}
          fields={fields}
          initial={edit || {}}
          onClose={() => setEdit(undefined)}
          onSave={async (data) => {
            edit ? await update(edit.id, data) : await create(data);
            setEdit(undefined);
          }}
        />
      ) : null}
    </div>
  );
}

const detailTabList = ["Overview", "Activity", "Notes", "Emails", "History"] as const;
type DetailTab = (typeof detailTabList)[number];
const activityFilters = [
  "All",
  "Emails",
  "Calls",
  "Meetings",
  "Notes",
  "System",
] as const;
type ActivityFilter = (typeof activityFilters)[number];
const activityFilterTypes: Partial<Record<ActivityFilter, string>> = {
  Emails: "Email",
  Calls: "Call",
  Meetings: "Meeting",
  Notes: "Note",
  System: "System",
};

function RecordDetailPage({
  resource,
  fields,
  title,
}: {
  resource: string;
  fields: FieldSpec[];
  title: string;
}) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useApp();
  const [record, setRecord] = useState<Row | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<DetailTab>("Overview");
  const [edit, setEdit] = useState(false);
  const [activities, setActivities] = useState<Row[]>([]);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("All");
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState(false);
  const [messages, setMessages] = useState<Row[]>([]);
  const [revisions, setRevisions] = useState<Row[]>([]);
  const [noteText, setNoteText] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);

  const recordName = record?.name || record?.title || "Untitled";
  const showActivityFilters =
    resource === "contacts" || resource === "companies";

  const photoKey = resource === "companies" ? "logo" : "avatar";
  const photoField: FieldSpec = {
    key: photoKey,
    label: resource === "companies" ? "Logo" : "Photo",
    type: "photo",
  };
  const detailFields: FieldSpec[] = [photoField, ...fields];

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    api<Row>(`/${resource}/${id}`)
      .then((r) => {
        setRecord(r);
        setLoading(false);
      })
      .catch(() => {
        toast("Record not found", "error");
        navigate(`/${resource}`, { replace: true });
      });
  }, [id, resource]);

  useEffect(() => {
    if (!record || (tab !== "Activity" && tab !== "Notes")) return;
    const params = new URLSearchParams({ recordId: record.id });
    const name = record.name || record.title || "";
    if (name) params.set("contact", name);
    const type =
      tab === "Notes"
        ? "Note"
        : showActivityFilters
          ? activityFilterTypes[activityFilter]
          : undefined;
    if (type) params.set("type", type);
    const controller = new AbortController();
    setActivities([]);
    setActivityError(false);
    setActivityLoading(true);
    api<Row[]>(`/activities?${params}`, { signal: controller.signal })
      .then(setActivities)
      .catch((error) => {
        if (error.name !== "AbortError") setActivityError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setActivityLoading(false);
      });
    return () => controller.abort();
  }, [record, tab, activityFilter, showActivityFilters]);

  useEffect(() => {
    if (!record?.email) return;
    api<Row[]>("/messages")
      .then((items) => setMessages(items.filter((m) => m.to === record.email)))
      .catch(() => {});
    api<{ data: Row[] }>("/activities")
      .then(({ data: items }) =>
        setActivities(
          items.filter(
            (a) =>
              a.contact === recordName ||
              a.title?.toLowerCase().includes(recordName.toLowerCase()),
          ),
        ),
      )
      .catch(() => {});
    if (record.email)
      api<{ data: Row[] }>("/messages")
        .then(({ data: items }) =>
          setMessages(items.filter((m) => m.to === record.email)),
        )
        .catch(() => {});
    if (resource === "contacts")
      api<{ data: Row[] }>(`/revisions/${resource}/${record.id}`)
        .then((result) => setRevisions(result.data))
        .catch(() => setRevisions([]));
  }, [record]);

  async function addNote() {
    if (!noteText.trim() || !record) return;
    setNoteBusy(true);
    try {
      const note = await api<Row>(
        "/activities",
        json("POST", {
          title: `Note on ${title.slice(0, -1)}`,
          type: "Note",
          contact: record.name || record.title || "",
          date: new Date().toISOString().slice(0, 10),
          notes: noteText,
        }),
      );
      setActivities((prev) => [note, ...prev]);
      setNoteText("");
      toast("Note added");
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setNoteBusy(false);
    }
  }

  async function deleteRecord() {
    if (!record || !confirm(`Delete ${recordName}?`)) return;
    try {
      await api(`/${resource}/${record.id}`, { method: "DELETE" });
      toast("Deleted");
      navigate(`/${resource}`, { replace: true });
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  if (loading)
    return (
      <div className="page">
        <div className="table-loading">Loading…</div>
      </div>
    );
  if (!record) return null;

  const activityIcon = (type: string) => {
    const m: Record<string, string> = {
      Note: "edit",
      Meeting: "calendar",
      Email: "inbox",
      SMS: "inbox",
      Call: "phone",
    };
    const c: Record<string, string> = {
      Note: "tone-purple",
      Meeting: "tone-blue",
      Email: "tone-green",
      SMS: "tone-amber",
      Call: "tone-red",
    };
    return (
      <span className={`activity-icon ${c[type] || "tone-blue"}`}>
        <Icon name={m[type] || "activity"} />
      </span>
    );
  };

  return (
    <div className="page">
      <div className="detail-header">
        <button
          className="btn ghost compact"
          onClick={() => navigate(`/${resource}`)}
        >
          <Icon name="arrowRight" /> Back to {title}
        </button>
        <div className="detail-header-main">
          <Avatar
            name={recordName}
            src={record.avatar || record.logo}
            size={48}
          />
         <div>
  <div className="lead-detail-name">
    <h1>{recordName}</h1>

    {resource === "leads" &&
    typeof record.leadScore === "number" ? (
      <span title="AI Score — based on engagement signals">
        <Badge
          tone={
            record.leadScore <= 40
              ? "red"
              : record.leadScore <= 70
                ? "amber"
                : "green"
          }
        >
          {record.leadScore}
        </Badge>
      </span>
    ) : null}
  </div>

  <p>
    {record.company || record.role || record.industry || ""}
    {record.email ? ` · ${record.email}` : ""}
  </p>
</div>
          <div className="detail-actions">
            {resource === "quotes" ? (
              <GenerateInvoiceButton key={record.id} quote={record} />
            ) : null}
            {record.status ? (
              <Badge
                tone={
                  record.status === "Qualified" || record.status === "Won"
                    ? "green"
                    : record.status === "Lost"
                      ? "red"
                      : "blue"
                }
              >
                {record.status}
              </Badge>
            ) : null}
            <button
              className="btn secondary compact"
              onClick={() => setEdit(true)}
            >
              <Icon name="edit" /> Edit
            </button>
            <button
              className="btn ghost compact danger-link"
              aria-label={`Delete ${record.name || record.title || "record"}`}
              onClick={deleteRecord}
            >
              <Icon name="trash" />
            </button>
          </div>
        </div>
      </div>

      <div className="detail-tabs">
        {(resource === "contacts"
          ? detailTabList
          : detailTabList.filter((item) => item !== "History")
        ).map((t) => (
          <button
            key={t}
            className={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t}
            {t === "Emails" && messages.length ? (
              <span>{messages.length}</span>
            ) : t === "Activity" && tab === "Activity" && activities.length ? (
              <span>{activities.length}</span>
            ) : t === "History" && revisions.length ? (
              <span>{revisions.length}</span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="detail-body">
        {tab === "Overview" && (
          <div className="detail-overview">
            <div className="detail-section">
              <h3>Contact information</h3>
              <div className="detail-props">
                {fields.map((f) =>
                  record[f.key] ? (
                    <div key={f.key}>
                      <dt>{f.label}</dt>
                      <dd>
                        {f.type === "number" && f.key === "value"
                          ? money(record[f.key])
                          : String(record[f.key])}
                      </dd>
                    </div>
                  ) : null,
                )}
              </div>
            </div>
          </div>
        )}

        {tab === "Activity" && (
          <div className="detail-activity">
            {showActivityFilters && (
              <div
                className="detail-tabs activity-filter-tabs"
                role="group"
                aria-label="Filter activities"
              >
                {activityFilters.map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    aria-pressed={activityFilter === filter}
                    className={activityFilter === filter ? "active" : ""}
                    onClick={() => setActivityFilter(filter)}
                  >
                    {filter}
                  </button>
                ))}
              </div>
            )}
            {activityLoading ? (
              <div className="table-loading">Loading activities…</div>
            ) : activityError ? (
              <Empty
                icon="activity"
                title="Could not load activities"
                text="Try another filter."
              />
            ) : activities.length ? (
              activities.map((a) => (
                <div className="activity-item" key={a.id}>
                  {activityIcon(a.type)}
                  <div>
                    <div className="activity-item-head">
                      <b>{a.title || a.type}</b>
                      <time>{a.date || a.createdAt || ""}</time>
                    </div>
                    <p>
                      {a.notes || a.type}
                      {a.contact ? (
                        <>
                          {" "}
                          — <strong>{a.contact}</strong>
                        </>
                      ) : null}
                    </p>
                  </div>
                </div>
              ))
            ) : (
              <Empty
                icon="activity"
                title="No activity yet"
                text="Activities related to this record will appear here."
              />
            )}
          </div>
        )}

        {tab === "Notes" && (
          <div className="detail-notes">
            <div className="note-compose">
              <textarea
                aria-label="Add a note"
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder="Write a note…"
                rows={3}
              />
              <button
                className="btn primary compact"
                disabled={noteBusy || !noteText.trim()}
                onClick={addNote}
              >
                {noteBusy ? "Saving…" : "Add note"}
              </button>
            </div>
            {!activityLoading &&
              activities
                .filter((a) => a.type === "Note")
                .map((n) => (
                  <div className="note-card" key={n.id}>
                    <div className="note-card-head">
                      <b>Note</b>
                      <time>{n.date || n.createdAt || ""}</time>
                    </div>
                    <p>{n.notes || n.title}</p>
                  </div>
                ))}
            {activityLoading ? (
              <div className="table-loading">Loading notes…</div>
            ) : activityError ? (
              <Empty
                icon="edit"
                title="Could not load notes"
                text="Try reopening this tab."
              />
            ) : !activities.filter((a) => a.type === "Note").length &&
              !noteText ? (
              <Empty
                icon="edit"
                title="No notes yet"
                text="Add the first note for this record."
              />
            ) : null}
          </div>
        )}

        {tab === "Emails" && (
          <div className="detail-emails">
            {messages.length ? (
              messages.map((m) => (
                <div className="email-item" key={m.id}>
                  <div className="email-item-head">
                    <Badge
                      tone={
                        m.status === "Sent"
                          ? "green"
                          : m.status === "Failed"
                            ? "red"
                            : "blue"
                      }
                    >
                      {m.channel || "Email"}
                    </Badge>
                    <b>{m.subject || "(no subject)"}</b>
                    <time>{m.createdAt || ""}</time>
                  </div>
                  <p>{m.body || ""}</p>
                  <span className="email-meta">To: {m.to}</span>
                </div>
              ))
            ) : (
              <Empty
                icon="inbox"
                title="No emails yet"
                text="Emails sent to this contact will appear here."
              />
            )}
          </div>
        )}

        {tab === "History" && resource === "contacts" && (
          <div className="detail-activity">
            {revisions.length ? (
              revisions.map((revision) => (
                <div className="activity-item" key={revision.id}>
                  <span className="activity-icon tone-blue">
                    <Icon name="edit" />
                  </span>
                  <div>
                    <div className="activity-item-head">
                      <b>{revision.actor || "System"}</b>
                      <time>{revision.createdAt || ""}</time>
                    </div>
                    {revision.changes?.map((change: Row) => (
                      <p key={`${revision.id}-${change.field}`}>
                        <strong>{change.field}</strong>: {String(change.from ?? "—")} → {String(change.to ?? "—")}
                      </p>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <Empty
                icon="edit"
                title="No history yet"
                text="Changes to this contact will appear here."
              />
            )}
          </div>
        )}
      </div>

      {edit ? (
        <RecordForm
          title={`Edit ${title.slice(0, -1)}`}
          fields={detailFields}
          initial={record}
          onClose={() => setEdit(false)}
          onSave={async (data) => {
            try {
              const payload = { ...record, ...data };
              await api(`/${resource}/${record.id}`, json("PUT", payload));
              setRecord((prev) => (prev ? { ...prev, ...payload } : prev));
              setEdit(false);
              toast("Updated");
            } catch (error) {
              toast((error as Error).message, "error");
            }
          }}
        />
      ) : null}
    </div>
  );
}

function RecordForm({
  title,
  fields,
  initial,
  onClose,
  onSave,
  toolbar,
}: {
  title: string;
  fields: FieldSpec[];
  initial: Row | Record<string, any>;
  onClose: () => void;
  onSave: (data: Record<string, any>) => Promise<void>;
  toolbar?: ReactNode;
}) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);

  const defaultValues = Object.fromEntries(
    fields.map((field) => [
      field.key,
      initial[field.key] ??
        (field.type === "select"
          ? field.options?.[0] || ""
          : field.type === "checkbox"
            ? false
            : ""),
    ]),
  );

  const {
    register,
    handleSubmit,
    watch,
    setValue,
  } = useForm<Record<string, any>>({
    defaultValues,
  });

  async function save(data: Record<string, any>) {
    const missing = fields.find(
      (field) => field.required && !String(data[field.key] ?? "").trim(),
    );

    if (missing) {
      return toast(`${missing.label} is required`, "error");
    }

    setBusy(true);

    try {
      await onSave(data);
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title={title}
      subtitle="Changes are saved directly to your workspace."
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Cancel
          </button>

          <button
            className="btn primary"
            disabled={busy}
            onClick={handleSubmit(save)}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="drawer-form">
        {toolbar}

        {fields.map((field) =>
          field.type === "photo" ? (
            <PhotoField
              key={field.key}
              label={field.label}
              name={String(watch("name") || watch("title") || "")}
              value={watch(field.key)}
              onChange={(url: string) => setValue(field.key, url)}
            />
          ) : field.type === "checkbox" ? (
            <label className="toggle-row" key={field.key}>
              <input type="checkbox" {...register(field.key)} />
              <span>{field.label}</span>
            </label>
          ) : (
            <label className="field" key={field.key}>
              <span>
                {field.label}
                {field.required ? (
                  <em className="required-mark">*</em>
                ) : null}
              </span>

              {field.type === "select" ? (
                <select {...register(field.key)}>
                  {field.options?.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : field.type === "textarea" ? (
                <textarea
                  {...register(field.key)}
                  placeholder={field.placeholder}
                  rows={6}
                />
              ) : (
                <input
                  type={field.type || "text"}
                  {...register(field.key, {
                    setValueAs: (value) =>
                      field.type === "number"
                        ? Number(value)
                        : value,
                  })}
                  placeholder={field.placeholder}
                />
              )}
            </label>
          ),
        )}
      </div>
    </Drawer>
  );
}
function LegacyCompaniesPage() {
  const fields: FieldSpec[] = [
    { key: "logo", label: "Logo", type: "photo" },
    { key: "name", label: "Company name" },
    { key: "industry", label: "Industry" },
    { key: "website", label: "Website" },
    { key: "country", label: "Country" },
    { key: "employees", label: "Employees", type: "number" },
    { key: "owner", label: "Owner" },
  ];
  const { items, create, update, remove } = useResource<Row>("companies");
  const { toast } = useApp();
  const navigate = useNavigate();
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  const custom = useSchema("companies");
  const nonPhoto = fields.filter((f) => f.key !== "logo");
  const photoField = fields.find((f) => f.key === "logo")!;
  const allFields = [
    photoField,
    ...nonPhoto,
    ...custom.filter((field) => !fields.some((base) => base.key === field.key)),
  ];
  async function exportCsv() {
    try {
      await downloadResourceCsv("companies");
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }
  return (
    <div className="page">
      <PageHeader
        title="Companies"
        description="Accounts, organizations and relationship ownership."
      >
        <button className="btn secondary" onClick={exportCsv}>
          <Icon name="download" /> Export CSV
        </button>
        <button className="btn primary" onClick={() => setEdit(null)}>
          <Icon name="plus" /> Add company
        </button>
      </PageHeader>
      {items.length ? (
        <div className="company-grid">
          {items.map((company) => (
            <article
              className="company-card"
              key={company.id}
              onClick={() => navigate(`/companies/${company.id}`)}
              style={{ cursor: "pointer" }}
            >
              <header>
                <span className="company-logo">
                  {company.logo ? (
                    <img src={company.logo} alt="" />
                  ) : (
                    String(company.name || "NX")
                      .split(/\s+/)
                      .map((x: string) => x[0])
                      .join("")
                      .slice(0, 2)
                      .toUpperCase()
                  )}
                </span>
                <div
                  className="row-actions"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className="icon-btn tiny"
                    aria-label={`Edit ${company.name || "company"}`}
                    onClick={() => setEdit(company)}
                  >
                    <Icon name="edit" />
                  </button>
                  <button
                    className="icon-btn tiny danger-link"
                    aria-label={`Delete ${company.name || "company"}`}
                    onClick={() =>
                      confirm("Delete this company?") && remove(company.id)
                    }
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              </header>
              <h3>{company.name || "Untitled company"}</h3>
              <p>
                {company.industry || "No industry"}
                {company.country ? ` · ${company.country}` : ""}
              </p>
              <div className="company-meta">
                <span>
                  <small>Employees</small>
                  <b>{company.employees || 0}</b>
                </span>
                <span>
                  <small>Owner</small>
                  <b>{company.owner || "—"}</b>
                </span>
              </div>
              <footer>
                <Badge>{company.website || "No website"}</Badge>
                <span className="link-btn">Open account</span>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          icon="companies"
          title="No companies"
          text="Add companies to connect contacts and deals to accounts."
          action={
            <button
              className="btn primary compact"
              onClick={() => setEdit(null)}
            >
              Add company
            </button>
          }
        />
      )}
      {edit !== undefined ? (
        <RecordForm
          title={`${edit ? "Edit" : "Add"} company`}
          fields={allFields}
          initial={edit || {}}
          onClose={() => setEdit(undefined)}
          onSave={async (data) => {
            edit ? await update(edit.id, data) : await create(data);
            setEdit(undefined);
          }}
        />
      ) : null}
    </div>
  );
}

function LegacyPipelinePage() {
  const { items, create, update, remove } = useResource<Row>("deals");
  const [pipelineStages, setPipelineStages] = useState<
    { name: string; probability: number }[]
  >([]);

  useEffect(() => {
    api<{
      stages: { name: string; probability: number }[];
    }>("/pipeline")
      .then((data) => setPipelineStages(data.stages))
      .catch(() => setPipelineStages([]));
  }, []);
  const navigate = useNavigate();
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  const [dragging, setDragging] = useState<string | null>(null);
  const custom = useSchema("deals");
  const fields: FieldSpec[] = [
    { key: "title", label: "Deal name" },
    { key: "company", label: "Company" },
    { key: "value", label: "Value", type: "number" },
    {
      key: "stage",
      label: "Stage",
      type: "select",
      options: stages.map((x) => x.id),
    },
    { key: "owner", label: "Owner" },
    { key: "closeDate", label: "Close date", type: "date" },
  ];
  const allFields = [
    ...fields,
    ...custom.filter((field) => !fields.some((base) => base.key === field.key)),
  ];
  async function drop(stage: string) {
    if (!dragging) return;
    await update(dragging, { stage });
    setDragging(null);
  }
  const probabilityByStage = Object.fromEntries(
    pipelineStages.map((stage) => [
      stage.name.toLowerCase(),
      stage.probability,
    ]),
  );

  const totalPipelineValue = items.reduce(
    (sum, row) => sum + Number(row.value || 0),
    0,
  );

  const weightedPipelineValue = items.reduce((sum, row) => {
    const probability =
      probabilityByStage[String(row.stage || "new").toLowerCase()] ?? 0;

    return sum + Number(row.value || 0) * (probability / 100);
  }, 0);
  return (
    <div className="page pipeline-page">
      <PageHeader
        title="Pipeline"
        description="Drag deals between stages and keep your pipeline moving."
      >
        <button className="btn primary" onClick={() => setEdit(null)}>
          <Icon name="plus" /> Add deal
        </button>
      </PageHeader>
      <div className="pipeline-summary">
        <div className="summary-card">
          <span>Total pipeline value</span>
          <strong>{money(totalPipelineValue)}</strong>
        </div>

        <div className="summary-card">
          <span>Weighted value</span>
          <strong>{money(weightedPipelineValue)}</strong>
        </div>
      </div>
      {items.length ? (
        <div className="pipeline-board">
          {stages.map((stage) => {
            const rows = items.filter(
              (item) => (item.stage || "new") === stage.id,
            );
            return (
              <section
                className="pipeline-column"
                key={stage.id}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => drop(stage.id)}
              >
                <header>
                  <div>
                    <span className="dot" />
                    <b>{stage.label}</b>
                    <em>{rows.length}</em>
                  </div>
                  <strong>
                    {money(
                      rows.reduce(
                        (sum, row) => sum + Number(row.value || 0),
                        0,
                      ),
                    )}
                  </strong>
                </header>
                <div className="deal-list">
                  {rows.map((row) => (
                    <article
                      className="deal-card"
                      key={row.id}
                      draggable
                      onDragStart={() => setDragging(row.id)}
                    >
                      <div className="deal-top">
                        <Badge tone={stage.id === "won" ? "green" : "blue"}>
                          {stage.label}
                        </Badge>
                        <div className="row-actions">
                          <button
                            className="icon-btn tiny"
                            aria-label={`Edit ${row.title || "deal"}`}
                            onClick={() => setEdit(row)}
                          >
                            <Icon name="edit" />
                          </button>
                          <button
                            className="icon-btn tiny danger-link"
                            aria-label={`Delete ${row.title || "deal"}`}
                            onClick={() =>
                              confirm("Delete this deal?") && remove(row.id)
                            }
                          >
                            <Icon name="trash" />
                          </button>
                        </div>
                      </div>
                      <button
                        className="deal-title"
                        onClick={() => navigate(`/deals/${row.id}`)}
                      >
                        {row.title || "Untitled deal"}
                      </button>
                      <p>{row.company || "No company"}</p>
                      <strong>{money(row.value || 0)}</strong>
                      <footer>
                        <span>{row.owner || "Unassigned"}</span>
                        <small>{row.closeDate || "No close date"}</small>
                      </footer>
                    </article>
                  ))}
                  <button
                    className="add-deal"
                    onClick={() => setEdit({ id: "", stage: stage.id })}
                  >
                    <Icon name="plus" /> Add deal
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <Empty
          icon="pipeline"
          title="No deals"
          text="Add your first deal to start building the sales pipeline."
          action={
            <button
              className="btn primary compact"
              onClick={() => setEdit(null)}
            >
              Add deal
            </button>
          }
        />
      )}
      {edit !== undefined ? (
        <RecordForm
          title={`${edit?.id ? "Edit" : "Add"} deal`}
          fields={allFields}
          initial={edit || { stage: "new" }}
          onClose={() => setEdit(undefined)}
          onSave={async (data) => {
            edit?.id ? await update(edit.id, data) : await create(data);
            setEdit(undefined);
          }}
        />
      ) : null}
    </div>
  );
}

function ActivitiesPage() {
  const { items, create, update, remove } = useResource<Row>("activities");
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  const fields: FieldSpec[] = [
    { key: "title", label: "Activity title" },
    {
      key: "type",
      label: "Type",
      type: "select",
      options: ["Note", "Meeting", "Email", "SMS", "Call"],
    },
    { key: "contact", label: "Contact" },
    { key: "date", label: "Date", type: "date" },
    { key: "notes", label: "Notes", type: "textarea" },
  ];
  return (
    <SimpleCards
      title="Activities"
      description="Meetings, notes and customer touchpoints."
      icon="activity"
      items={items}
      onAdd={() => setEdit(null)}
      onEdit={setEdit}
      onDelete={remove}
      render={(item) => (
        <>
          <div className="activity-item-head">
            <Badge tone="blue">{item.type || "Note"}</Badge>
            <small>
              {item.date || new Date(item.createdAt).toLocaleDateString()}
            </small>
          </div>
          <h3>{item.title || "Untitled activity"}</h3>
          <p>{item.contact || item.notes || "No details"}</p>
        </>
      )}
      modal={
        edit !== undefined ? (
          <RecordForm
            title={`${edit ? "Edit" : "Add"} activity`}
            fields={fields}
            initial={edit || {}}
            onClose={() => setEdit(undefined)}
            onSave={async (data) => {
              edit ? await update(edit.id, data) : await create(data);
              setEdit(undefined);
            }}
          />
        ) : null
      }
    />
  );
}

function TasksPage() {
  const { items, create, update, remove } = useResource<Row>("tasks");
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  const fields: FieldSpec[] = [
    { key: "title", label: "Task title" },
    { key: "owner", label: "Owner" },
    {
      key: "priority",
      label: "Priority",
      type: "select",
      options: ["Low", "Medium", "High", "Urgent"],
    },
    {
      key: "status",
      label: "Status",
      type: "select",
      options: ["Open", "In progress", "Completed"],
    },
    { key: "dueDate", label: "Due date", type: "date" },
  ];
  return (
    <div className="page">
      <PageHeader
        title="Tasks"
        description="Work queue, ownership and due dates."
      >
        <button className="btn primary" onClick={() => setEdit(null)}>
          <Icon name="plus" /> Add task
        </button>
      </PageHeader>
      {items.length ? (
        <div className="task-board">
          {["Open", "In progress", "Completed"].map((status) => (
            <section className="task-column" key={status}>
              <header>
                <b>{status}</b>
                <span>
                  {items.filter((x) => (x.status || "Open") === status).length}
                </span>
              </header>
              {items
                .filter((x) => (x.status || "Open") === status)
                .map((task) => (
                  <article className="task-card" key={task.id}>
                    <div>
                      <button
                        className={`task-check ${status === "Completed" ? "checked" : ""}`}
                        aria-label={
                          status === "Completed"
                            ? `Mark ${task.title || "task"} as open`
                            : `Mark ${task.title || "task"} as completed`
                        }
                        onClick={() =>
                          update(task.id, {
                            status:
                              status === "Completed" ? "Open" : "Completed",
                          })
                        }
                      >
                        <Icon name="check" />
                      </button>
                      <div>
                        <b>{task.title || "Untitled task"}</b>
                        <small>
                          {task.owner || "Unassigned"} ·{" "}
                          {task.dueDate || "No due date"}
                        </small>
                      </div>
                    </div>
                    <footer>
                      <Badge
                        tone={
                          task.priority === "Urgent" || task.priority === "High"
                            ? "red"
                            : "neutral"
                        }
                      >
                        {task.priority || "Medium"}
                      </Badge>
                      <div className="row-actions">
                        <button
                          className="icon-btn tiny"
                          aria-label={`Edit ${task.title || "task"}`}
                          onClick={() => setEdit(task)}
                        >
                          <Icon name="edit" />
                        </button>
                        <button
                          className="icon-btn tiny danger-link"
                          aria-label={`Delete ${task.title || "task"}`}
                          onClick={() =>
                            confirm("Delete this task?") && remove(task.id)
                          }
                        >
                          <Icon name="trash" />
                        </button>
                      </div>
                    </footer>
                  </article>
                ))}
            </section>
          ))}
        </div>
      ) : (
        <Empty
          icon="tasks"
          title="No tasks"
          text="Create tasks for follow-ups, meetings and sales work."
          action={
            <button
              className="btn primary compact"
              onClick={() => setEdit(null)}
            >
              Add task
            </button>
          }
        />
      )}
      {edit !== undefined ? (
        <RecordForm
          title={`${edit ? "Edit" : "Add"} task`}
          fields={fields}
          initial={edit || { status: "Open", priority: "Medium" }}
          onClose={() => setEdit(undefined)}
          onSave={async (data) => {
            edit ? await update(edit.id, data) : await create(data);
            setEdit(undefined);
          }}
        />
      ) : null}
    </div>
  );
}

function CalendarPage() {
  const tasks = useResource<Row>("tasks");
  const activities = useResource<Row>("activities");
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const [cursor, setCursor] = useState<Date>(
    () => new Date(today.getFullYear(), today.getMonth(), 1),
  );
  const [quick, setQuick] = useState<{
    date: string;
    kind: "Task" | "Activity" | null;
  } | null>(null);
  const events: Row[] = [
    ...tasks.items.map((x): Row => ({ ...x, date: x.dueDate, kind: "Task" })),
    ...activities.items.map((x): Row => ({ ...x, kind: "Activity" })),
  ].filter((x) => x.date);
  const taskFields: FieldSpec[] = [
    { key: "title", label: "Task title", required: true },
    { key: "owner", label: "Owner" },
    {
      key: "priority",
      label: "Priority",
      type: "select",
      options: ["Low", "Medium", "High", "Urgent"],
    },
    { key: "dueDate", label: "Due date", type: "date", required: true },
  ];
  const activityFields: FieldSpec[] = [
    { key: "title", label: "Activity title", required: true },
    {
      key: "type",
      label: "Type",
      type: "select",
      options: ["Meeting", "Call", "Email", "SMS", "Note"],
    },
    { key: "contact", label: "Contact" },
    { key: "date", label: "Date", type: "date", required: true },
    { key: "notes", label: "Notes", type: "textarea" },
  ];

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < new Date(year, month, 1).getDay(); i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++)
    cells.push(
      `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    );
  while (cells.length % 7) cells.push(null);
  const byDay = (key: string) => events.filter((e) => e.date === key);
  const upcoming = events
    .filter((e) => e.date >= todayKey)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(0, 10);
  const monthLabel = cursor.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
  const monthShort = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const kind = quick?.kind ?? "Activity";

  return (
    <div className="page">
      <PageHeader
        title="Calendar"
        description="Month view of tasks and due dates. Click a day to schedule."
      >
        <button
          className="btn secondary"
          onClick={() =>
            setCursor(new Date(today.getFullYear(), today.getMonth(), 1))
          }
        >
          Today
        </button>
        <button
          className="btn secondary"
          onClick={() => setQuick({ date: todayKey, kind: "Task" })}
        >
          <Icon name="plus" /> New task
        </button>
        <button
          className="btn primary"
          onClick={() => setQuick({ date: todayKey, kind: "Activity" })}
        >
          <Icon name="plus" /> Schedule activity
        </button>
      </PageHeader>
      <section className="surface calendar-shell">
        <div className="calendar-top">
          <button
            className="icon-btn"
            aria-label="Previous month"
            onClick={() =>
              setCursor((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))
            }
          >
            <Icon name="arrowLeft" />
          </button>
          <h2>{monthLabel}</h2>
          <button
            className="icon-btn"
            aria-label="Next month"
            onClick={() =>
              setCursor((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))
            }
          >
            <Icon name="arrowRight" />
          </button>
          <span className="cal-legend">
            <i className="t-task" />
            Tasks
            <i className="t-act" />
            Activities
          </span>
        </div>
        <div className="cal-grid">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
            <div className="cal-dow" key={day}>
              <span>{day}</span>
            </div>
          ))}
          {cells.map((key, idx) =>
            key ? (
              <div
                key={key}
                className={`cal-day${key === todayKey ? " today" : ""}`}
                onClick={() => setQuick({ date: key, kind: null })}
              >
                <span className="cal-date">{Number(key.slice(-2))}</span>
                {byDay(key)
                  .slice(0, 3)
                  .map((event) => (
                    <div
                      key={`${event.kind}-${event.id}`}
                      className={`cal-chip${event.kind === "Task" ? " chip-task" : " chip-activity"}`}
                      title={`${event.kind}: ${event.title || ""}`}
                    >
                      <span className="chip-dot" />
                      <em>{event.title || "Untitled"}</em>
                    </div>
                  ))}
                {byDay(key).length > 3 ? (
                  <span className="cal-more">
                    +{byDay(key).length - 3} more
                  </span>
                ) : null}
              </div>
            ) : (
              <div key={`pad${idx}`} className="cal-day pad" />
            ),
          )}
        </div>
      </section>
      <section className="surface cal-upcoming">
        <div className="section-head">
          <div>
            <h2>Upcoming</h2>
            <p>Next ten scheduled items</p>
          </div>
        </div>
        {upcoming.length ? (
          upcoming.map((event) => {
            const [, m, d] = event.date.split("-").map(Number);
            return (
              <button
                key={`${event.kind}-${event.id}`}
                className="upcoming-row"
                onClick={() => setQuick({ date: event.date, kind: event.kind })}
              >
                <b>
                  {monthShort[m - 1]} {d}
                </b>
                <span>
                  <Icon name={event.kind === "Task" ? "tasks" : "activity"} />
                  {event.title || "Untitled"}
                </span>
                <small>{event.kind}</small>
              </button>
            );
          })
        ) : (
          <p className="cal-empty">
            Nothing upcoming. Click a day on the calendar to plan a task or
            activity.
          </p>
        )}
      </section>
      {quick ? (
        <RecordForm
          key={kind}
          title={kind === "Task" ? "Add task" : "Schedule activity"}
          fields={kind === "Task" ? taskFields : activityFields}
          initial={
            kind === "Task"
              ? { status: "Open", priority: "Medium", dueDate: quick.date }
              : { type: "Meeting", date: quick.date }
          }
          onClose={() => setQuick(null)}
          onSave={async (data) => {
            kind === "Task"
              ? await tasks.create(data)
              : await activities.create(data);
            setQuick(null);
          }}
          toolbar={
            <div className="quick-kind">
              <button
                className={kind === "Task" ? "on" : ""}
                onClick={() =>
                  setQuick((current) =>
                    current ? { ...current, kind: "Task" } : current,
                  )
                }
              >
                <Icon name="tasks" /> Task
              </button>
              <button
                className={kind === "Activity" ? "on" : ""}
                onClick={() =>
                  setQuick((current) =>
                    current ? { ...current, kind: "Activity" } : current,
                  )
                }
              >
                <Icon name="activity" /> Activity
              </button>
            </div>
          }
        />
      ) : null}
    </div>
  );
}

type WorkflowActionRow = {
  type: string;
  to?: string;
  subject?: string;
  body?: string;
  title?: string;
  owner?: string;
  priority?: string;
  dueDate?: string;
  field?: string;
  value?: string;
  notes?: string;
  [key: string]: any;
};
type WorkflowMeta = {
  events: { value: string; label: string }[];
  actions: { type: string; label: string; fields: string[] }[];
};

function WorkflowForm({
  initial,
  meta,
  onClose,
  onSave,
}: {
  initial: Record<string, any>;
  meta: WorkflowMeta;
  onClose: () => void;
  onSave: (data: Record<string, any>) => Promise<void>;
}) {
  const { toast } = useApp();
  const [name, setName] = useState(initial.name || "");
  const [event, setEvent] = useState(
    initial.event || meta.events[0]?.value || "",
  );
  const [filterField, setFilterField] = useState(initial.filter?.field || "");
  const [filterValue, setFilterValue] = useState(initial.filter?.value || "");
  const [actions, setActions] = useState<WorkflowActionRow[]>(
    initial.actions?.length ? initial.actions : [{ type: "task", title: "" }],
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!event && meta.events.length) setEvent(meta.events[0].value);
  }, [meta.events, event]);
  const actionFields = meta.actions.reduce(
    (acc, action) => {
      acc[action.type] = action.fields;
      return acc;
    },
    {} as Record<string, string[]>,
  );
  const fieldLabels: Record<string, string> = {
    to: "To ({{email}} works)",
    subject: "Subject",
    body: "Body",
    title: "Title",
    owner: "Owner",
    priority: "Priority",
    dueDate: "Due date",
    field: "Field to update",
    value: "New value",
    notes: "Notes",
  };
  const setAction = (index: number, patch: Partial<WorkflowActionRow>) =>
    setActions((list) =>
      list.map((action, i) => (i === index ? { ...action, ...patch } : action)),
    );

  async function save() {
    if (!name.trim()) return toast("Workflow name is required", "error");
    if (!event) return toast("Choose a trigger event", "error");
    if (!actions.length) return toast("Add at least one action", "error");
    setBusy(true);
    try {
      await onSave({
        name: name.trim(),
        event,
        filter:
          filterField && filterValue
            ? { field: filterField.trim(), value: filterValue.trim() }
            : null,
        actions,
      });
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title={initial.id ? "Edit workflow" : "New workflow"}
      subtitle="Automate actions when a CRM event happens."
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? "Saving…" : "Save workflow"}
          </button>
        </>
      }
    >
      <div className="drawer-form">
        <label className="field">
          <span>Workflow name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Follow up on new leads"
          />
        </label>
        <label className="field">
          <span>Trigger</span>
          <select value={event} onChange={(e) => setEvent(e.target.value)}>
            {meta.events.length ? (
              meta.events.map((ev) => (
                <option key={ev.value} value={ev.value}>
                  {ev.label}
                </option>
              ))
            ) : (
              <option value="">Loading triggers…</option>
            )}
          </select>
        </label>
        <div className="form-grid">
          <label className="field">
            <span>Filter field (optional)</span>
            <input
              value={filterField}
              onChange={(e) => setFilterField(e.target.value)}
              placeholder="status"
            />
          </label>
          <label className="field">
            <span>Filter value</span>
            <input
              value={filterValue}
              onChange={(e) => setFilterValue(e.target.value)}
              placeholder="Qualified"
            />
          </label>
        </div>
        <span className="drawer-label">Actions</span>
        {actions.map((action, index) => (
          <div className="workflow-action" key={index}>
            <div className="workflow-action-head">
              <select
                aria-label={`Action ${index + 1} type`}
                value={action.type}
                onChange={(e) => setAction(index, { type: e.target.value })}
              >
                {meta.actions.map((a) => (
                  <option key={a.type} value={a.type}>
                    {a.label}
                  </option>
                ))}
              </select>
              <button
                className="icon-btn tiny danger-link"
                onClick={() =>
                  setActions((list) => list.filter((_, i) => i !== index))
                }
                title="Remove action"
              >
                <Icon name="trash" />
              </button>
            </div>
            {(actionFields[action.type] || []).map((key) => (
              <label className="field" key={key}>
                <span>{fieldLabels[key] || key}</span>
                {key === "priority" ? (
                  <select
                    value={action.priority || ""}
                    onChange={(e) =>
                      setAction(index, { priority: e.target.value })
                    }
                  >
                    <option value="">—</option>
                    <option>Low</option>
                    <option>Medium</option>
                    <option>High</option>
                    <option>Urgent</option>
                  </select>
                ) : key === "body" || key === "notes" ? (
                  <textarea
                    value={action[key] || ""}
                    onChange={(e) =>
                      setAction(index, { [key]: e.target.value })
                    }
                    rows={3}
                    placeholder={fieldLabels[key]}
                  />
                ) : (
                  <input
                    value={action[key] || ""}
                    onChange={(e) =>
                      setAction(index, { [key]: e.target.value })
                    }
                    placeholder={fieldLabels[key]}
                  />
                )}
              </label>
            ))}
          </div>
        ))}
        <button
          className="btn secondary full"
          onClick={() =>
            setActions((list) => [...list, { type: "task", title: "" }])
          }
        >
          <Icon name="plus" /> Add action
        </button>
      </div>
    </Drawer>
  );
}

function WorkflowsPage() {
  const { items, loading, error, load, create, update, remove } = useResource<Row>("workflows");
  const navigate = useNavigate();
  const location = useLocation();
  const [pickerOpen, setPickerOpen] = useState(() => new URLSearchParams(location.search).get("picker") === "1");
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  const [meta, setMeta] = useState<WorkflowMeta>({
    events: [],
    actions: [],
  });

  useEffect(() => {
    api<WorkflowMeta>("/workflows/meta")
      .then(setMeta)
      .catch(() => {});
  }, []);

  return (
    <div className="page">
      <PageHeader
        title="Workflows"
        description="Automate follow-ups: pick a trigger, add actions, and Tunaxa runs them server-side."
      >
        <button type="button" className="btn secondary" onClick={() => setPickerOpen(true)}>
          <Icon name="workflow" /> Open Canvas
        </button>
        <button
          className="btn primary"
          disabled={!meta.events.length}
          onClick={() => setEdit(null)}
        >
          <Icon name="plus" /> New workflow
        </button>
      </PageHeader>

      {loading ? <p role="status">Loading workflows…</p> : error ? (
        <Empty icon="workflow" title="Could not load workflows" text="Try loading the list again."
          action={<button type="button" className="btn secondary" onClick={() => load()}>Retry</button>} />
      ) : items.length ? (
        <>
          {/* Liste des workflows existants */}
          <div className="workflow-list">
            {items.map((flow) => (
              <article
                className="surface workflow-card"
                key={flow.id}
              >
                <div className="workflow-top">
                  <span className="workflow-icon">
                    <Icon name="workflow" />
                  </span>

                  <div className="workflow-copy">
                    <h3>{flow.name || "Untitled workflow"}</h3>

                    <p className="workflow-path">
                      <span className="workflow-trigger">
                        <Icon name="spark" />

                        {flow.event
                          ? meta.events.find(
                              (e) => e.value === flow.event
                            )?.label || flow.event
                          : "Legacy (text)"}
                      </span>

                      <span className="workflow-arrow">
                        <Icon name="arrowRight" />
                      </span>

                      <span className="workflow-action-note">
                        {flow.actions?.length
                          ? `${flow.actions.length} action${
                              flow.actions.length > 1 ? "s" : ""
                            }`
                          : "No actions"}
                      </span>

                      {flow.filter?.field ? (
                        <span className="workflow-filter">
                          when {flow.filter.field} = {flow.filter.value}
                        </span>
                      ) : null}
                    </p>
                  </div>

                </div>
                <div className="flow-actions">
                  <Toggle
                    label={`${flow.enabled ? "Disable" : "Enable"} ${flow.name || "workflow"}`}
                    value={Boolean(flow.enabled)}
                    onChange={(enabled) => update(flow.id, { enabled })}
                  />
                  <button
                    className="icon-btn tiny"
                    aria-label={`Edit ${flow.name || "workflow"}`}
                    onClick={() => setEdit(flow)}
                  >
                    <Icon name="edit" />
                  </button>
                  <button
                    className="icon-btn tiny danger-link"
                    aria-label={`Delete ${flow.name || "workflow"}`}
                    onClick={() =>
                      confirm("Delete this workflow?") && remove(flow.id)
                    }
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </>
      ) : (
        <Empty
          icon="workflow"
          title="No workflows"
          text="Create a trigger and action pair to automate your sales work."
          action={
            <button
              className="btn primary compact"
              onClick={() => setEdit(null)}
            >
              New workflow
            </button>
          }
        />
      )}

      {pickerOpen ? (
        <WorkflowPicker workflows={items} loading={loading} error={error}
          onRetry={() => load()} onClose={() => setPickerOpen(false)}
          onSelect={(id) => { setPickerOpen(false); navigate(`/workflows/${encodeURIComponent(id)}`); }} />
      ) : null}
      {edit !== undefined ? (
        <WorkflowForm
          meta={meta}
          initial={edit || {}}
          onClose={() => setEdit(undefined)}
          onSave={async (data) => {
            edit?.id
              ? await update(edit.id, data)
              : await create({
                  ...data,
                  enabled: true,
                });

            setEdit(undefined);
          }}
        />
      ) : null}
    </div>
  );
}

function CallsPage() {
  const { items, load, create, remove } = useResource<Row>("calls");
  const { toast } = useApp();
  const [number, setNumber] = useState("");
  const [active, setActive] = useState<Row | null>(null);
  const [started, setStarted] = useState<number | null>(null);
  const [ending, setEnding] = useState(false);
  const [twilio, setTwilio] = useState(false);
  const keypad = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

  useEffect(() => {
    api<{ configured: boolean }>("/twilio/status")
      .then((result) => setTwilio(result.configured))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (active) return;
    const existing = items.find((call) => call.status === "Connected");
    if (!existing) return;
    setActive(existing);
    setNumber(existing.phone || "");
    setStarted(
      existing.startedAt ? new Date(existing.startedAt).getTime() : Date.now(),
    );
  }, [items, active]);

  async function startCall() {
    if (!number.trim()) return toast("Enter a phone number", "error");
    try {
      let call;
      if (twilio) {
        call = await api<Row>(
          "/calls/dial",
          json("POST", { phone: number.trim() }),
        );
        toast("Call placed via Twilio");
      } else {
        call = await create({
          phone: number.trim(),
          direction: "Outbound",
          status: "Connected",
          startedAt: new Date().toISOString(),
          duration: 0,
        });
        toast("Call session started");
      }
      setActive(call);
      setStarted(Date.now());
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  async function endCall() {
    if (!active || ending) return;
    setEnding(true);
    try {
      const duration = started
        ? Math.max(1, Math.floor((Date.now() - started) / 1000))
        : 0;
      const result = await api<{ call: Row; recording?: Row; activity?: Row }>(
        `/calls/${active.id}/complete`,
        json("POST", { duration, endedAt: new Date().toISOString() }),
      );
      await load();
      setActive(null);
      setStarted(null);
      setNumber("");
      toast(
        result.recording
          ? "Call completed and recording record created"
          : "Call completed",
      );
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setEnding(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Telephony"
        description="Start calls from the dialer. With Twilio configured, real calls are placed; otherwise Tunaxa logs the local call session."
      />
      <div className="calls-grid">
        <section className="surface dialer-card">
          <div className="dialer-head">
            <span className={`phone-status ${active ? "calling" : ""}`}>
              <i />
              {active ? "Connected" : "Ready"}
            </span>
            <button
              className="icon-btn"
              disabled={Boolean(active)}
              onClick={() => setNumber("")}
              title="Clear"
            >
              <Icon name="close" />
            </button>
          </div>
          <input
            className="dial-input"
            aria-label="Phone number"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder="Enter a number"
            disabled={Boolean(active)}
          />
          <div className="keypad">
            {keypad.map((key) => (
              <button
                key={key}
                disabled={Boolean(active)}
                onClick={() => setNumber((value) => value + key)}
              >
                {key}
              </button>
            ))}
          </div>
          {active ? (
            <button
              className="call-button danger"
              disabled={ending}
              onClick={endCall}
            >
              <Icon name="phone" /> {ending ? "Ending…" : "End call"}
            </button>
          ) : (
            <button className="call-button" onClick={startCall}>
              <Icon name="phone" /> {twilio ? "Call via Twilio" : "Start call"}
            </button>
          )}
          <div className="call-note">
            <Icon name="warning" />
            <span>
              {twilio
                ? "Twilio is configured. Calls are placed through your provider and require a public webhook URL in Settings."
                : "Actual phone connectivity requires a configured telephony provider. Tunaxa still logs the local call session and related CRM activity."}
            </span>
          </div>
        </section>
        <section className="surface call-history">
          <div className="section-head">
            <div>
              <h2>Call history</h2>
              <p>
                {items.length
                  ? `${items.length} calls logged`
                  : "Calls will appear here automatically"}
              </p>
            </div>
          </div>
          {items.length ? (
            items.map((call) => (
              <article className="call-row" key={call.id}>
                <span
                  className={`call-direction ${call.direction === "Inbound" ? "received" : ""}`}
                >
                  <Icon name="phone" />
                </span>
                <div>
                  <b>{call.contact || call.phone || "Unknown number"}</b>
                  <small>
                    {call.direction || "Outbound"} · {call.status || "Logged"} ·{" "}
                    {call.duration || 0}s
                    {call.provider ? ` · ${call.provider}` : ""}
                  </small>
                </div>
                <time>{new Date(call.createdAt).toLocaleString()}</time>
                <button
                  className="icon-btn tiny danger-link"
                  onClick={() =>
                    confirm("Delete this call log?") && remove(call.id)
                  }
                  title="Delete call"
                >
                  <Icon name="trash" />
                </button>
              </article>
            ))
          ) : (
            <Empty
              icon="phone"
              title="No calls"
              text="Use the dialer to make your first call. Call logs are created automatically."
            />
          )}
        </section>
      </div>
    </div>
  );
}

function RecordingsPage() {
  const { items, load, remove } = useResource<Row>("recordings");
  const { toast } = useApp();
  const [selected, setSelected] = useState<Row | null>(null);
  const [transcribing, setTranscribing] = useState(false);

  async function summarize(item: Row) {
    try {
      const result = await api<Row>(
        `/recordings/${item.id}/summarize`,
        json("POST"),
      );
      setSelected(result);
      toast("Summary updated");
      load();
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  async function transcribe(item: Row) {
    setTranscribing(true);

    try {
      const result = await api<Row>(
        `/recordings/${item.id}/transcribe`,
        json("POST"),
      );

      setSelected(result);
      toast("Transcription ready");
      await load();
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setTranscribing(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Recordings"
        description="Recording records are created automatically from completed calls."
      />
      {items.length ? (
        <section className="surface recordings-list">
          {items.map((item) => (
            <article className="recording-row" key={item.id}>
              <button
                className="play-btn"
                disabled={!item.fileUrl}
                onClick={() => setSelected(item)}
                title={
                  item.fileUrl
                    ? "Open recording"
                    : "Audio will be available when a provider supplies media"
                }
              >
                <Icon name={item.fileUrl ? "play" : "recording"} />
              </button>
              <div className="recording-person">
                <button
                  className="recording-title"
                  onClick={() => setSelected(item)}
                >
                  {item.title || item.originalName || "Call recording"}
                </button>
                <small>
                  {item.contact || item.phone || "No linked contact"} ·{" "}
                  {new Date(item.createdAt).toLocaleString()}
                </small>
              </div>
              <Badge tone={item.fileUrl ? "green" : "amber"}>
                {item.mediaStatus ||
                  (item.fileUrl ? "Audio ready" : "Awaiting audio")}
              </Badge>
              <div className="row-actions">
                <button
                  className="btn secondary compact"
                  onClick={() => setSelected(item)}
                >
                  Open
                </button>
                <button
                  className="icon-btn tiny danger-link"
                  onClick={() =>
                    confirm("Delete this recording record?") && remove(item.id)
                  }
                  title="Delete"
                >
                  <Icon name="trash" />
                </button>
              </div>
            </article>
          ))}
        </section>
      ) : (
        <Empty
          icon="recording"
          title="No recordings"
          text="Complete a call and Tunaxa will create its recording record automatically when call recording is enabled."
        />
      )}
      {selected ? (
        <Modal
          title={selected.title || "Recording"}
          onClose={() => setSelected(null)}
          footer={
            <>
              <button
                className="btn secondary"
                onClick={() => setSelected(null)}
              >
                Close
              </button>
              <button
                className="btn secondary"
                disabled={!selected.fileUrl || transcribing}
                onClick={() => transcribe(selected)}
              >
                <Icon name="ai" />
                {transcribing ? "Processing transcript..." : "Transcribe"}
              </button>
              <button
                className="btn primary"
                disabled={!selected.transcript}
                onClick={() => summarize(selected)}
              >
                <Icon name="spark" /> Generate summary
              </button>
            </>
          }
        >
          {selected.fileUrl ? (
            <audio controls src={selected.fileUrl} className="audio-player" />
          ) : (
            <div className="media-pending">
              <Icon name="recording" />
              <div>
                <b>Audio is not available yet</b>
                <p>
                  This call record was created automatically. A connected
                  telephony provider can attach the actual call media here.
                </p>
              </div>
            </div>
          )}
          <div className="recording-detail">
            <h3>
              Summary{" "}
              {selected.summaryAi ? <Badge tone="green">AI</Badge> : null}
            </h3>
            <p>{selected.summary || "No summary yet."}</p>
            <h3>Transcript</h3>

            <div
              className="transcript-text"
              style={{
                maxHeight: "280px",
                overflowY: "auto",
                whiteSpace: "pre-wrap",
                padding: "12px",
              }}
            >
              {transcribing ? (
                <span>Processing transcript...</span>
              ) : selected.transcript ? (
                selected.transcript
              ) : (
                <span>No transcript is available yet.</span>
              )}
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function InboxPage() {
  const { toast } = useApp();

  const [messages, setMessages] = useState<Row[]>([]);
  const [selectedThread, setSelectedThread] = useState<Row[]>([]);
  const [activeFilter, setActiveFilter] = useState<
    "All" | "Unread" | "Sent" | "Tracked"
  >("All");

  const [page, setPage] = useState(1);
  const [limit] = useState(20);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);

  const [compose, setCompose] = useState(false);
  const [sending, setSending] = useState(false);

  const [templates, setTemplates] = useState<Row[]>([]);
  const [templateId, setTemplateId] = useState("");
  const {
  register,
  handleSubmit,
  reset,
  watch,
  setValue,
} = useForm<{
  channel: string;
  to: string;
  subject: string;
  body: string;
}>({
  defaultValues: {
    channel: "Email",
    to: "",
    subject: "",
    body: "",
  },
});

  const [draft, setDraft] = useState<Row>({
    id: "",
    channel: "Email",
    to: "",
    subject: "",
    body: "",
  });

  async function loadMessages(targetPage = page) {
    setLoading(true);

    try {
      const response = await api<{
        items: Row[];
        total: number;
        page: number;
        limit: number;
        hasMore: boolean;
      }>(
        `/messages?type=email&page=${targetPage}&limit=${limit}`,
      );

      setMessages(response.items || []);
      setTotal(response.total || 0);
      setHasMore(Boolean(response.hasMore));

      if (response.items?.length && !selectedThread.length) {
        setSelectedThread([response.items[0]]);
      }
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadMessages(page);
  }, [page]);

  useEffect(() => {
    api<Row[]>("/templates")
      .then(setTemplates)
      .catch(() => {});
  }, []);

  function applyTemplate(id: string) {
    setTemplateId(id);

    const template = templates.find((item) => item.id === id);

    if (!template) return;

    setDraft((prev) => ({
      ...prev,
      subject: template.subject || "",
      body: template.body || "",
    }));
  }

  function getThreadKey(message: Row) {
    return `${String(message.to || "").toLowerCase()}::${String(
      message.subject || "",
    )
      .trim()
      .toLowerCase()}`;
  }

  const threads = Array.from(
    messages.reduce((map, message) => {
      const key = getThreadKey(message);

      if (!map.has(key)) {
        map.set(key, []);
      }

      map.get(key)!.push(message);

      return map;
    }, new Map<string, Row[]>()),
  ).map(([key, thread]) => ({
    key,
    messages: thread.sort(
      (a, b) =>
        new Date(a.createdAt || 0).getTime() -
        new Date(b.createdAt || 0).getTime(),
    ),
  }));

  const filteredThreads = threads.filter(({ messages: thread }) => {
    if (!thread.length) return false;

    if (activeFilter === "Unread") {
      return thread.some((message) => !message.read);
    }

    if (activeFilter === "Sent") {
      return thread.some(
        (message) =>
          message.direction === "Outbound" ||
          message.status === "Sent",
      );
    }

    if (activeFilter === "Tracked") {
      return thread.some(
        (message) =>
          Boolean(message.openedAt) || Boolean(message.clickedAt),
      );
    }

    return true;
  });

  function openThread(thread: Row[]) {
    setSelectedThread(thread);

    const unread = thread.filter((message) => !message.read);

    unread.forEach((message) => {
      api(`/messages/${message.id}`, json("PATCH", { read: true })).catch(
        () => {},
      );
    });

    setMessages((current) =>
      current.map((message) =>
        thread.some((item) => item.id === message.id)
          ? { ...message, read: true }
          : message,
      ),
    );
  }

  async function sendMessage(message: Row) {
    setSending(true);

    try {
      const saved = await api<Row>(
        "/messages/send",
        json("POST", {
          id: message.id,
          channel: "Email",
          to: message.to,
          subject: message.subject,
          body: message.body,
          contact: message.contact,
        }),
      );

      setCompose(false);
      setTemplateId("");
      setDraft({
        id: "",
        channel: "Email",
        to: "",
        subject: "",
        body: "",
      });

      await loadMessages(page);

      setSelectedThread([saved]);

      toast(
        saved.deliveredAt
          ? "Message sent"
          : saved.status === "Failed"
            ? "Delivery failed"
            : "Message saved for later",
      );
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setSending(false);
    }
  }

  async function deleteMessage(message: Row) {
    if (!confirm("Delete this message?")) return;

    try {
      await api(`/messages/${message.id}`, json("DELETE"));

      setSelectedThread([]);

      await loadMessages(page);

      toast("Message deleted");
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  const selectedLastMessage =
    selectedThread[selectedThread.length - 1] || null;

  return (
    <div className="page">
      <PageHeader
        title="Unified Inbox"
        description="Manage your email conversations from one place."
      >
        <button
          className="btn primary"
          onClick={() => {
            setDraft({
              id: "",
              channel: "Email",
              to: "",
              subject: "",
              body: "",
            });
            setTemplateId("");
            setCompose(true);
          }}
        >
          <Icon name="send" /> Compose
        </button>
      </PageHeader>

      <section
        className="surface"
        style={{
          overflow: "hidden",
          minHeight: "650px",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* FILTERS */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "14px 18px",
            borderBottom: "1px solid var(--border, #e5e7eb)",
          }}
        >
          {(["All", "Unread", "Sent", "Tracked"] as const).map((filter) => (
            <button
              key={filter}
              className={
                activeFilter === filter
                  ? "btn primary compact"
                  : "btn secondary compact"
              }
              onClick={() => setActiveFilter(filter)}
            >
              {filter}
            </button>
          ))}

          <span
            style={{
              marginLeft: "auto",
              fontSize: "12px",
              opacity: 0.65,
            }}
          >
            {total} email{total !== 1 ? "s" : ""}
          </span>
        </div>

        {/* SPLIT PANE */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "360px minmax(0, 1fr)",
            minHeight: "580px",
            flex: 1,
          }}
        >
          {/* LEFT PANE */}
          <aside
            style={{
              borderRight: "1px solid var(--border, #e5e7eb)",
              overflowY: "auto",
            }}
          >
            {loading ? (
              <div style={{ padding: "30px", textAlign: "center" }}>
                Loading conversations…
              </div>
            ) : filteredThreads.length ? (
              filteredThreads.map(({ key, messages: thread }) => {
                const last = thread[thread.length - 1];
                const unread = thread.some((message) => !message.read);
                const active = selectedThread.some(
                  (message) => message.id === last.id,
                );

                return (
                  <button
                    key={key}
                    onClick={() => openThread(thread)}
                    style={{
                      width: "100%",
                      display: "block",
                      textAlign: "left",
                      padding: "16px",
                      border: "0",
                      borderBottom:
                        "1px solid var(--border, #e5e7eb)",
                      background: active
                        ? "rgba(59, 130, 246, 0.08)"
                        : "transparent",
                      cursor: "pointer",
                      fontWeight: unread ? 700 : 400,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: "12px",
                      }}
                    >
                      <span>
                        {last.to || "Unknown recipient"}
                      </span>

                      <time
                        style={{
                          fontSize: "11px",
                          opacity: 0.6,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {last.createdAt
                          ? new Date(
                              last.createdAt,
                            ).toLocaleDateString()
                          : ""}
                      </time>
                    </div>

                    <div
                      style={{
                        marginTop: "6px",
                        fontSize: "13px",
                        fontWeight: unread ? 700 : 500,
                      }}
                    >
                      {last.subject || "No subject"}
                    </div>

                    <div
                      style={{
                        marginTop: "5px",
                        fontSize: "12px",
                        opacity: 0.65,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {last.body || "No content"}
                    </div>

                    <div
                      style={{
                        display: "flex",
                        gap: "8px",
                        marginTop: "9px",
                        alignItems: "center",
                      }}
                    >
                      {unread ? (
                        <Badge tone="blue">Unread</Badge>
                      ) : null}

                      {last.status ? (
                        <Badge
                          tone={
                            last.status === "Sent"
                              ? "green"
                              : last.status === "Failed"
                                ? "red"
                                : "amber"
                          }
                        >
                          {last.status}
                        </Badge>
                      ) : null}

                      {last.openedAt || last.clickedAt ? (
                        <span
                          style={{
                            fontSize: "11px",
                            opacity: 0.7,
                          }}
                        >
                          <Icon name="eye" /> Tracked
                        </span>
                      ) : null}
                    </div>
                  </button>
                );
              })
            ) : (
              <div style={{ padding: "40px 20px" }}>
                <Empty
                  icon="inbox"
                  title="No conversations"
                  text="No email conversations match this filter."
                />
              </div>
            )}

            {/* PAGINATION */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "12px",
                borderTop: "1px solid var(--border, #e5e7eb)",
                position: "sticky",
                bottom: 0,
                background: "var(--surface, white)",
              }}
            >
              <button
                className="btn secondary compact"
                disabled={page <= 1 || loading}
                onClick={() => {
                  setPage((current) => Math.max(1, current - 1));
                  setSelectedThread([]);
                }}
              >
                Previous
              </button>

              <span style={{ fontSize: "12px", opacity: 0.65 }}>
                Page {page}
              </span>

              <button
                className="btn secondary compact"
                disabled={!hasMore || loading}
                onClick={() => {
                  setPage((current) => current + 1);
                  setSelectedThread([]);
                }}
              >
                Next
              </button>
            </div>
          </aside>

          {/* RIGHT PANE */}
          <main
            style={{
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            {selectedThread.length ? (
              <>
                <header
                  style={{
                    padding: "18px 22px",
                    borderBottom:
                      "1px solid var(--border, #e5e7eb)",
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "16px",
                  }}
                >
                  <div>
                    <h3 style={{ margin: 0 }}>
                      {selectedLastMessage?.subject || "No subject"}
                    </h3>

                    <small style={{ opacity: 0.65 }}>
                      {selectedLastMessage?.to}
                    </small>
                  </div>

                  {selectedLastMessage ? (
                    <button
                      className="icon-btn danger-link"
                      title="Delete message"
                      onClick={() =>
                        deleteMessage(selectedLastMessage)
                      }
                    >
                      <Icon name="trash" />
                    </button>
                  ) : null}
                </header>

                <div
                  style={{
                    flex: 1,
                    overflowY: "auto",
                    padding: "22px",
                  }}
                >
                  {selectedThread.map((message) => {
                    const outbound =
                      message.direction === "Outbound";

                    return (
                      <article
                        key={message.id}
                        style={{
                          marginBottom: "18px",
                          maxWidth: "85%",
                          marginLeft: outbound ? "auto" : "0",
                        }}
                      >
                        <div
                          style={{
                            fontSize: "11px",
                            opacity: 0.6,
                            marginBottom: "6px",
                          }}
                        >
                          {outbound ? "You" : message.to} ·{" "}
                          {message.createdAt
                            ? new Date(
                                message.createdAt,
                              ).toLocaleString()
                            : ""}
                        </div>

                        <div
                          style={{
                            padding: "16px",
                            borderRadius: "12px",
                            background: outbound
                              ? "rgba(59, 130, 246, 0.10)"
                              : "var(--surface-muted, #f5f5f5)",
                            border:
                              "1px solid var(--border, #e5e7eb)",
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          {message.body || "No content"}
                        </div>

                        <div
                          style={{
                            display: "flex",
                            gap: "8px",
                            marginTop: "6px",
                            fontSize: "11px",
                            opacity: 0.65,
                          }}
                        >
                          {message.status ? (
                            <span>{message.status}</span>
                          ) : null}

                          {message.openedAt ? (
                            <span>
                              <Icon name="eye" /> Opened{" "}
                              {message.openCount || 1}×
                            </span>
                          ) : null}

                          {message.clickedAt ? (
                            <span>
                              Clicked {message.clickCount || 1}×
                            </span>
                          ) : null}
                        </div>
                      </article>
                    );
                  })}
                </div>

                <footer
                  style={{
                    padding: "14px 20px",
                    borderTop:
                      "1px solid var(--border, #e5e7eb)",
                    display: "flex",
                    justifyContent: "flex-end",
                  }}
                >
                  <button
                    className="btn primary"
                    disabled={sending}
                    onClick={() =>
                      sendMessage({
                        ...selectedLastMessage,
                        id: "",
                        body: "",
                      })
                    }
                  >
                    <Icon name="send" /> Reply
                  </button>
                </footer>
              </>
            ) : (
              <div
                style={{
                  flex: 1,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <Empty
                  icon="inbox"
                  title="Select a conversation"
                  text="Choose an email thread from the list."
                />
              </div>
            )}
          </main>
        </div>
      </section>

      {/* COMPOSE */}
      {compose ? (
        <Drawer
          title="New email"
          subtitle="Compose a new email message."
          onClose={() => {
  setCompose(false);
  setTemplateId("");
  reset();
}}
          footer={
            <button
              className="btn secondary"
              onClick={() => {
                setCompose(false);
                setTemplateId("");
              }}
            >
              Cancel
            </button>
          }
        >
          <div className="drawer-form">
            {templates.length ? (
              <label className="field">
                <span>Template</span>

                <select
                  value={templateId}
                  onChange={(e) => applyTemplate(e.target.value)}
                >
                  <option value="">No template</option>

                  {templates.map((template) => (
                    <option
                      key={template.id}
                      value={template.id}
                    >
                      {template.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="field">
              <span>Recipient *</span>

              <input
                type="email"
                value={draft.to || ""}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    to: e.target.value,
                  }))
                }
                placeholder="recipient@example.com"
              />
            </label>

            <label className="field">
              <span>Subject</span>

              <input
                type="text"
                value={draft.subject || ""}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    subject: e.target.value,
                  }))
                }
                placeholder="Email subject"
              />
            </label>

            <label className="field">
              <span>Message *</span>

              <textarea
                value={draft.body || ""}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    body: e.target.value,
                  }))
                }
                placeholder="Write your email…"
                rows={8}
              />
            </label>

            <button
              className="btn primary"
              disabled={!draft.to || !draft.body || sending}
              onClick={() => sendMessage(draft)}
            >
              {sending ? "Sending…" : "Send email"}
            </button>
          </div>
        </Drawer>
      ) : null}
    </div>
  );
}

function SequencesPage() {
  const { items, create, update, remove } = useResource<Row>("sequences");
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  const fields: FieldSpec[] = [
    { key: "name", label: "Sequence name" },
    { key: "audience", label: "Audience / segment" },
    { key: "steps", label: "Steps description", type: "textarea" },
  ];
  return (
    <SimpleCards
      title="Sequences"
      description="Reusable multi-step outreach plans."
      icon="sequence"
      items={items}
      onAdd={() => setEdit(null)}
      onEdit={setEdit}
      onDelete={remove}
      render={(item) => (
        <>
          <div className="deal-top">
            <Badge tone={item.enabled ? "green" : "neutral"}>
              {item.enabled ? "Active" : "Paused"}
            </Badge>
            <Toggle
              label={`${item.enabled ? "Disable" : "Enable"} ${item.name || "sequence"}`}
              value={Boolean(item.enabled)}
              onChange={(enabled) => update(item.id, { enabled })}
            />
          </div>
          <h3>{item.name || "Untitled sequence"}</h3>
          <p>{item.audience || "No audience selected"}</p>
          <small>{item.steps || "No steps added"}</small>
        </>
      )}
      modal={
        edit !== undefined ? (
          <RecordForm
            title={`${edit ? "Edit" : "New"} sequence`}
            fields={fields}
            initial={edit || {}}
            onClose={() => setEdit(undefined)}
            onSave={async (data) => {
              edit
                ? await update(edit.id, data)
                : await create({ ...data, enabled: false });
              setEdit(undefined);
            }}
          />
        ) : null
      }
    />
  );
}

function CampaignsPage() {
  return (
    <CrudTablePage
      resource="campaigns"
      title="Campaigns"
      description="Plan and track marketing campaigns end to end."
      icon="campaign"
      fields={campaignFields}
      nameKey="name"
      statusField="status"
      synopsis={(r) => r.channel || ""}
      moneyColumn={[]}
    />
  );
}
function EmailListsPage() {
  return (
    <CrudTablePage
      resource="emailLists"
      title="Email Lists"
      description="Segmented subscriber lists for outreach."
      icon="inbox"
      fields={emailListFields}
      nameKey="name"
      statusField="status"
      synopsis={(r) => `${r.subscribers || 0} subscribers`}
    />
  );
}
function LandingPagesPage() {
  return (
    <CrudTablePage
      resource="landingPages"
      title="Landing Pages"
      description="Conversion pages and their performance."
      icon="landing"
      fields={landingPageFields}
      nameKey="name"
      statusField="status"
      synopsis={(r) =>
        `${r.views || 0} views · ${r.conversions || 0} conversions`
      }
    />
  );
}
function ProductsPage() {
  return (
    <CrudTablePage
      resource="products"
      title="Products"
      description="Product catalog with pricing and inventory."
      icon="cart"
      fields={productFields}
      nameKey="name"
      statusField="status"
      synopsis={(r) => r.sku || r.category || ""}
    />
  );
}
function OrdersPage() {
  return (
    <CrudTablePage
      resource="orders"
      title="Orders"
      description="Commerce orders, statuses and totals."
      icon="send"
      fields={orderFields}
      nameKey="orderNumber"
      statusField="status"
      synopsis={(r) => r.customer || r.email || ""}
      moneyColumn={["subtotal", "tax", "shipping", "total"]}
    />
  );
}
function InvoicesPage() {
  return (
    <CrudTablePage
      resource="invoices"
      title="Invoices"
      description="Bill customers and track payments."
      icon="invoice"
      fields={invoiceFields}
      nameKey="number"
      statusField="status"
      synopsis={(r) => r.customerName || r.customerEmail || ""}
      moneyColumn={["amount", "tax"]}
    />
  );
}
function ExpensesPage() {
  return (
    <CrudTablePage
      resource="expenses"
      title="Expenses"
      description="Record and categorise business spending."
      icon="reports"
      fields={expenseFields}
      nameKey="title"
      statusField="status"
      synopsis={(r) => r.category || r.vendor || ""}
      moneyColumn={["amount"]}
    />
  );
}
function EmployeesPage() {
  return (
    <CrudTablePage
      resource="employees"
      title="Employees"
      description="People directory, departments and payroll."
      icon="employee"
      fields={employeeFields}
      nameKey="name"
      statusField="status"
      synopsis={(r) => `${r.department || ""}${r.title ? " · " + r.title : ""}`}
    />
  );
}
function LeavePage() {
  return (
    <CrudTablePage
      resource="leaveRequests"
      title="Leave"
      description="Time-off requests and approvals."
      icon="leave"
      fields={leaveFields}
      nameKey="employee"
      statusField="status"
      synopsis={(r) =>
        `${r.type || ""}${r.days ? " · " + r.days + " days" : ""}`
      }
    />
  );
}
function AttendancePage() {
  return (
    <CrudTablePage
      resource="attendance"
      title="Attendance"
      description="Daily check-ins and attendance records."
      icon="clockIn"
      fields={attendanceFields}
      nameKey="employee"
      statusField="status"
      synopsis={(r) => r.date || ""}
    />
  );
}

function QuotesPage() {
  return (
    <CrudTablePage
      resource="quotes"
      title="Quotes"
      description="Generate and track quotes (estimate-to-contract)."
      icon="quote"
      fields={quoteFields}
      columns={quoteFields.filter((field) =>
        ["number", "customer", "total", "status", "expiryDate"].includes(
          field.key,
        ),
      )}
      nameKey="number"
      statusField="status"
      synopsis={(r) => r.customer || r.deal || ""}
      moneyColumn={["total"]}
      renderEditor={(props) => <QuoteForm {...props} />}
    />
  );
}
function ContractsPage() {
  return (
    <CrudTablePage
      resource="contracts"
      title="Contracts"
      description="Subscription terms, renewals and recurring revenue."
      icon="contract"
      fields={contractFields}
      nameKey="name"
      statusField="status"
      synopsis={(r) =>
        `${r.customer || ""}${r.billingFrequency ? " · " + r.billingFrequency : ""}`
      }
      moneyColumn={["value", "mrr"]}
    />
  );
}
function MarketingEmailsPage() {
  return (
    <CrudTablePage
      resource="marketingEmails"
      title="Marketing Emails"
      description="Design, send and measure bulk email engagement."
      icon="mail"
      fields={marketingEmailFields}
      nameKey="name"
      statusField="status"
      synopsis={(r) => r.subject || r.list || ""}
    />
  );
}
function EventsPage() {
  return (
    <CrudTablePage
      resource="marketingEvents"
      title="Events"
      description="Plan and track virtual and in-person events."
      icon="event"
      fields={marketingEventFields}
      nameKey="name"
      statusField="status"
      synopsis={(r) =>
        `${r.startDate ? String(r.startDate).slice(0, 10) + " · " : ""}${r.registrations || 0}/${r.capacity || 0} registered`
      }
    />
  );
}
function GoalsPage() {
  const { items, loading, load, create, update, remove } =
    useResource<Row>("goals");
  const { toast } = useApp();
  const navigate = useNavigate();
  const importRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  const [quickName, setQuickName] = useState("");
  const [quickMetric, setQuickMetric] = useState("Revenue");
  const [quickTarget, setQuickTarget] = useState("");
  const [quickPeriod, setQuickPeriod] = useState("Monthly");
  const [quickBusy, setQuickBusy] = useState(false);
  const [celebration, setCelebration] = useState<{
    goalName: string;
    milestone: GoalMilestone;
  } | null>(null);

  useEffect(() => {
    if (!celebration) return;
    const timer = window.setTimeout(() => setCelebration(null), 3200);
    return () => window.clearTimeout(timer);
  }, [celebration]);

  async function quickAddGoal(event: FormEvent) {
    event.preventDefault();
    const target = Number(quickTarget);
    if (!quickName.trim()) return toast("Goal name is required", "error");
    if (!Number.isFinite(target) || target <= 0)
      return toast("Target must be greater than zero", "error");

    setQuickBusy(true);
    try {
      await create({
        name: quickName.trim(),
        metric: quickMetric,
        period: quickPeriod,
        target,
        current: 0,
      });
      setQuickName("");
      setQuickTarget("");
      nameRef.current?.focus();
    } catch {
      // useResource displays the API error.
    } finally {
      setQuickBusy(false);
    }
  }

  async function importCsv(file: File) {
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) return toast("CSV has no rows", "error");
      const headers = lines[0]
        .split(",")
        .map((value) => value.trim().replace(/^"|"$/g, ""));
      const records = lines.slice(1).map((line) => {
        const values = line
          .split(",")
          .map((value) => value.trim().replace(/^"|"$/g, ""));
        return Object.fromEntries(
          headers.map((key, index) => [key, values[index] || ""]),
        );
      });
      await api("/goals/batch", json("POST", records));
      await load();
      toast(`${records.length} goals imported`);
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  }

  async function exportGoals() {
    try {
      await downloadResourceCsv("goals");
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  async function saveGoal(data: Record<string, any>) {
    const target = Number(data.target);
    const current = Number(data.current);
    if (!Number.isFinite(target) || target <= 0)
      throw new Error("Target must be greater than zero");
    if (!Number.isFinite(current) || current < 0)
      throw new Error("Current value cannot be negative");

    if (edit) {
      const milestone = getCrossedGoalMilestone(
        edit.current,
        edit.target,
        current,
        target,
      );
      const saved = await update(edit.id, { ...data, current, target });
      if (milestone) {
        setCelebration({
          goalName: String(saved.name || edit.name || "Goal"),
          milestone,
        });
      }
    } else {
      const saved = await create({ ...data, current, target });
      const milestone = getCrossedGoalMilestone(0, target, current, target);
      if (milestone) {
        setCelebration({
          goalName: String(saved.name || data.name || "Goal"),
          milestone,
        });
      }
    }
    setEdit(undefined);
  }

  return (
    <div className="page goals-page">
      <PageHeader
        title="Goals"
        description="Time-bound targets and progress across teams."
      >
        <input
          ref={importRef}
          hidden
          type="file"
          accept=".csv,text/csv"
          onChange={(event) =>
            event.target.files?.[0] && importCsv(event.target.files[0])
          }
        />
        <button
          className="btn secondary"
          onClick={() => importRef.current?.click()}
        >
          <Icon name="upload" /> Import
        </button>
        <button
          className="btn secondary"
          disabled={!items.length}
          onClick={exportGoals}
        >
          <Icon name="download" /> Export CSV
        </button>
        <button className="btn secondary" onClick={() => setEdit(null)}>
          <Icon name="plus" /> Full goal form
        </button>
      </PageHeader>

      <form className="surface goal-quick-add" onSubmit={quickAddGoal}>
        <div className="goal-quick-add-heading">
          <span className="goal-quick-add-icon">
            <Icon name="goal" />
          </span>
          <div>
            <h2>Quick-add goal</h2>
            <p>Create a goal now and fill in optional details later.</p>
          </div>
        </div>
        <label className="field">
          <span>Goal name</span>
          <input
            ref={nameRef}
            value={quickName}
            placeholder="e.g. Close 20 deals"
            onChange={(event) => setQuickName(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Metric</span>
          <select
            value={quickMetric}
            onChange={(event) => setQuickMetric(event.target.value)}
          >
            {goalFields[1].options?.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Target</span>
          <input
            type="number"
            min="0.01"
            step="any"
            value={quickTarget}
            placeholder="100"
            onChange={(event) => setQuickTarget(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Period</span>
          <select
            value={quickPeriod}
            onChange={(event) => setQuickPeriod(event.target.value)}
          >
            {goalFields[3].options?.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn primary goal-quick-add-submit"
          disabled={quickBusy}
          type="submit"
        >
          <Icon name="plus" /> {quickBusy ? "Adding…" : "Add goal"}
        </button>
      </form>

      {loading ? (
        <div className="table-loading">Loading goals…</div>
      ) : items.length ? (
        <div className="goal-card-grid">
          {items.map((goal) => {
            const progress = getGoalProgress(goal.current, goal.target);
            return (
              <article
                className={`surface goal-card goal-card--${progress.tone}`}
                key={goal.id}
              >
                <header>
                  <button
                    className="goal-card-title"
                    onClick={() => navigate(`/goals/${goal.id}`)}
                  >
                    <span>{goal.metric || "Goal"}</span>
                    <strong>{goal.name || "Untitled goal"}</strong>
                  </button>
                  <Badge tone={progress.tone}>{goal.period || "Monthly"}</Badge>
                </header>
                <GoalProgress
                  name={String(goal.name || "Goal")}
                  current={goal.current}
                  target={goal.target}
                />
                <div className="goal-card-meta">
                  <span>
                    <b>Owner</b> {goal.owner || "Unassigned"}
                  </span>
                  <span>
                    <b>Dates</b>{" "}
                    {goal.startDate || goal.endDate
                      ? `${goal.startDate || "Open"} – ${goal.endDate || "Open"}`
                      : "No date range"}
                  </span>
                </div>
                <footer>
                  <button
                    className="btn ghost compact"
                    onClick={() => navigate(`/goals/${goal.id}`)}
                  >
                    View details
                  </button>
                  <div className="row-actions">
                    <button
                      className="icon-btn tiny"
                      title="Edit goal"
                      aria-label={`Edit ${goal.name || "goal"}`}
                      onClick={() => setEdit(goal)}
                    >
                      <Icon name="edit" />
                    </button>
                    <button
                      className="icon-btn tiny danger-link"
                      title="Delete goal"
                      aria-label={`Delete ${goal.name || "goal"}`}
                      onClick={() =>
                        confirm(`Delete ${goal.name || "goal"}?`) && remove(goal.id)
                      }
                    >
                      <Icon name="trash" />
                    </button>
                  </div>
                </footer>
              </article>
            );
          })}
        </div>
      ) : (
        <Empty
          icon="goal"
          title="No goals yet"
          text="Use the quick-add form to create your first measurable goal."
          action={
            <button
              className="btn primary compact"
              onClick={() => nameRef.current?.focus()}
            >
              Add a goal
            </button>
          }
        />
      )}

      {edit !== undefined ? (
        <RecordForm
          title={`${edit ? "Edit" : "Add"} goal`}
          fields={goalFields}
          initial={edit || {}}
          onClose={() => setEdit(undefined)}
          onSave={saveGoal}
        />
      ) : null}

      {celebration ? (
        <div className="goal-celebration" aria-live="polite">
          <div className="goal-confetti" aria-hidden="true">
            {Array.from({ length: 36 }, (_, index) => (
              <i
                key={index}
                style={
                  {
                    left: `${(index * 37) % 100}%`,
                    animationDelay: `${(index % 9) * 0.08}s`,
                    animationDuration: `${1.8 + (index % 5) * 0.18}s`,
                  } as CSSProperties
                }
              />
            ))}
          </div>
          <div className="goal-celebration-message">
            <strong>{celebration.milestone}% milestone reached!</strong>
            <span>{celebration.goalName}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
function SurveysPage() {
  return (
    <CrudTablePage
      resource="surveys"
      title="Feedback Surveys"
      description="NPS, CSAT and CES surveys for customer feedback."
      icon="survey"
      fields={surveyFields}
      nameKey="name"
      statusField="status"
      synopsis={(r) =>
        `${r.type || ""}${r.targetScore ? " · Target " + r.targetScore : ""}`
      }
    />
  );
}
function SurveyResponsesPage() {
  return (
    <CrudTablePage
      resource="surveyResponses"
      title="Survey Responses"
      description="Individual answers and scores from feedback surveys."
      icon="response"
      fields={surveyResponseFields}
      nameKey="respondent"
      statusField="survey"
      synopsis={(r) => r.date || ""}
    />
  );
}

function DuplicatesPage() {
  const { toast } = useApp();
  const [scope, setScope] = useState<"contacts" | "companies">("contacts");
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState<string[]>([]);
  const load = () =>
    api<any>(`/duplicates?resource=${scope}`)
      .then(setData)
      .catch((err) => toast(err.message, "error"));
  useEffect(() => {
    setSkipped([]);
    load();
    window.addEventListener("tunaxa:resource-changed", load);
    return () => window.removeEventListener("tunaxa:resource-changed", load);
  }, [scope]);
  async function mergePair(group: any, keep: Row, merge: Row) {
    setBusy(true);
    try {
      await api(
        `/duplicates/merge`,
        json("POST", { resource: scope, keepId: keep.id, mergeId: merge.id }),
      );
      toast("Duplicate merged");
      load();
      window.dispatchEvent(new Event("tunaxa:resource-changed"));
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  function skipPair(key: string) {
    setSkipped((current) => [...current, key]);
  }
  const groups = (data?.duplicates || [])
    .map((group: any) => ({
      ...group,
      records:
        group.records ||
        group.ids.map((id: string, index: number) => ({
          id,
          name: group.names[index],
        })),
    }))
    .flatMap((group: any) =>
      group.records.slice(1).map((merge: Row) => ({
        group,
        keep: group.records[0] as Row,
        merge,
        key: `${group.records[0].id}:${merge.id}`,
      })),
    )
    .filter((pair: any) => !skipped.includes(pair.key));
  const pair = groups[0];
  const comparisonKeys = pair
    ? [
        ...new Set([...Object.keys(pair.keep), ...Object.keys(pair.merge)]),
      ].filter((key) => key !== "id")
    : [];
  const displayName = (record: Row) =>
    String(record.name || record.email || record.id || "Untitled");
  const displayValue = (value: unknown) => {
    if (value === undefined || value === null || value === "") return "—";
    if (Array.isArray(value)) return value.join(", ");
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  };
  const labelFor = (key: string) =>
    key
      .replace(/([A-Z])/g, " $1")
      .replace(/^./, (value) => value.toUpperCase());
  return (
    <div className="page">
      <PageHeader
        title="Duplicate Management"
        description="Find and merge duplicate contacts and companies sharing the same email or name."
      >
        <button
          className={
            scope === "contacts"
              ? "btn primary compact"
              : "btn secondary compact"
          }
          onClick={() => setScope("contacts")}
        >
          Contacts
        </button>
        <button
          className={
            scope === "companies"
              ? "btn primary compact"
              : "btn secondary compact"
          }
          onClick={() => setScope("companies")}
        >
          Companies
        </button>
      </PageHeader>
      <section className="surface duplicate-comparison">
        {pair ? (
          <>
            <div className="duplicate-comparison-head">
              <div>
                <span className="eyebrow">Potential duplicate</span>
                <h2>Review these records</h2>
              </div>
              <Badge tone="blue">{pair.group.confidence ?? 0}% match</Badge>
            </div>
            <div className="duplicate-columns">
              <article className="duplicate-record keep">
                <div className="duplicate-record-head">
                  <Avatar name={displayName(pair.keep)} />
                  <div>
                    <small>Record to keep</small>
                    <h3>{displayName(pair.keep)}</h3>
                  </div>
                </div>
                <div className="duplicate-fields">
                  {comparisonKeys.map((key) => (
                    <div className="duplicate-field" key={key}>
                      <span>{labelFor(key)}</span>
                      <b>{displayValue(pair.keep[key])}</b>
                    </div>
                  ))}
                </div>
              </article>
              <article className="duplicate-record merge">
                <div className="duplicate-record-head">
                  <Avatar name={displayName(pair.merge)} />
                  <div>
                    <small>Record to merge and delete</small>
                    <h3>{displayName(pair.merge)}</h3>
                  </div>
                </div>
                <div className="duplicate-fields">
                  {comparisonKeys.map((key) => (
                    <div className="duplicate-field" key={key}>
                      <span>{labelFor(key)}</span>
                      <b>{displayValue(pair.merge[key])}</b>
                    </div>
                  ))}
                </div>
              </article>
            </div>
            <div className="duplicate-actions">
              <button
                className="btn secondary"
                disabled={busy}
                onClick={() => skipPair(pair.key)}
              >
                <Icon name="close" /> Skip
              </button>
              <button
                className="btn primary"
                disabled={busy}
                onClick={() => mergePair(pair.group, pair.keep, pair.merge)}
              >
                <Icon name="check" /> Merge
              </button>
            </div>
          </>
        ) : (
          <Empty
            icon="duplicate"
            title={`No duplicate ${scope} found`}
            text={`No ${scope} currently share the same email/name. Data is clean.`}
          />
        )}
      </section>
    </div>
  );
}

function PortalView({
  scope,
  onBack,
}: {
  scope?: boolean;
  onBack?: () => void;
}) {
  const { toast } = useApp();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [portal, setPortal] = useState<any>(null);
  async function access() {
    if (!email.trim()) return toast("Enter a customer email", "error");
    setBusy(true);
    try {
      setPortal(await api<any>("/portal/access", json("POST", { email })));
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  const renderRow = (
    label: string,
    section: any[],
    nameKey: string,
    moneyKey?: string,
  ) =>
    section && section.length ? (
      <section className="surface portal-section">
        <div className="section-title-row">
          <h3>{label}</h3>
          <span className="table-count">{section.length}</span>
        </div>
        <div className="portal-list">
          {section.map((row: any) => (
            <div className="portal-row" key={row.id}>
              <div>
                <b>{row[nameKey] || "—"}</b>
                {row.status ? (
                  <Badge
                    tone={
                      row.status === "Accepted" ||
                      row.status === "Active" ||
                      row.status === "Paid"
                        ? "green"
                        : row.status === "Declined" ||
                            row.status === "Overdue" ||
                            row.status === "Expired"
                          ? "red"
                          : "blue"
                    }
                  >
                    {row.status}
                  </Badge>
                ) : null}
              </div>
              {moneyKey ? (
                <span className="portal-amount">
                  {money(Number(row[moneyKey] || 0))}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </section>
    ) : null;
  return (
    <div className={scope ? "page" : "portal-public-page"}>
      <div className={scope ? "page" : "portal-public-wrap"}>
        {scope ? (
          <PageHeader
            title="Customer Portal"
            description="Preview what a customer sees for their account."
          >
            {onBack ? (
              <button className="btn secondary" onClick={onBack}>
                <Icon name="arrowLeft" /> Portal home
              </button>
            ) : null}
          </PageHeader>
        ) : (
          <div className="portal-brand">
            <Icon name="portal" size={28} />
            <b>Tunaxa Customer Portal</b>
          </div>
        )}
        {!portal ? (
          <section className="surface portal-access-card">
            <h3>Access your account</h3>
            <p>
              Enter the email address on your account to view your quotes,
              contracts, invoices and support tickets.
            </p>
            <div className="portal-access-form">
              <input
                type="email"
                aria-label="Account email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
              />
              <button className="btn primary" onClick={access} disabled={busy}>
                <Icon name="search" /> View my account
              </button>
            </div>
          </section>
        ) : (
          <>
            {!scope && (
              <button
                className="btn secondary compact portal-back"
                onClick={() => {
                  setPortal(null);
                  setEmail("");
                  onBack?.();
                }}
              >
                <Icon name="arrowLeft" /> Sign out
              </button>
            )}
            <div className="portal-customer">
              <Avatar name={portal.customer?.name} />
              <div>
                <b>{portal.customer?.name}</b>
                <small>{portal.customer?.email}</small>
              </div>
            </div>
            {!portal.quotes?.length &&
            !portal.contracts?.length &&
            !portal.invoices?.length &&
            !portal.tickets?.length ? (
              <Empty
                icon="portal"
                title="No account records"
                text={`No quotes, contracts, invoices or tickets were found for ${portal.customer?.email}.`}
              />
            ) : (
              <div className="portal-grid">
                {renderRow("Quotes", portal.quotes, "number", "total")}
                {renderRow("Contracts", portal.contracts, "name", "value")}
                {renderRow("Invoices", portal.invoices, "number", "amount")}
                {renderRow("Support tickets", portal.tickets, "subject")}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
function PortalPage() {
  return <PortalView scope />;
}

function FinancePage() {
  const navigate = useNavigate();
  const [finance, setFinance] = useState<any>(null);
  useEffect(() => {
    const load = () =>
      api("/finance/summary")
        .then(setFinance)
        .catch(() => {});
    load();
    window.addEventListener("tunaxa:resource-changed", load);
    return () => window.removeEventListener("tunaxa:resource-changed", load);
  }, []);
  const cards = [
    [
      "Invoiced",
      money(finance?.issued || 0),
      `${finance?.paidCount || 0} paid · ${finance?.unpaidCount || 0} outstanding`,
      "invoice",
      "blue",
    ],
    [
      "Collected",
      money(finance?.paidValue || 0),
      `${money(finance?.dueValue || 0)} still due`,
      "checkCircle",
      "green",
    ],
    [
      "Expenses",
      money(finance?.totalExpenses || 0),
      "All time business spend",
      "reports",
      "amber",
    ],
    [
      "Net",
      money(finance?.net || 0),
      "Collected minus expenses",
      "trend",
      "purple",
    ],
  ];
  const bars = (finance?.monthly || []).slice(-6);
  const maxVal = Math.max(
    1,
    ...bars.flatMap((m: any) => [m.revenue, m.expenses]),
  );
  const barHeight = (v: number) => Math.max(4, Math.round((v / maxVal) * 100));
  const currentMonth = new Date().toLocaleString("en", {
    month: "short",
    year: "2-digit",
  });
  const currentExpenses =
    finance?.monthly?.find((x: any) => x.label === currentMonth)?.expenses || 0;
  return (
    <div className="page">
      <PageHeader
        title="Finance & Economics"
        description="Invoicing, expenses and the economic health of the business."
      >
        <button className="btn primary" onClick={() => navigate("/invoices")}>
          <Icon name="invoice" /> New invoice
        </button>
      </PageHeader>
      <div className="stats-grid">
        {cards.map((card) => (
          <div className="stat-card hover-crm-card relative" key={card[0]}>
            <CornerBrackets stroke="#3b82f6" size="sm" />
            <div className={`stat-icon tone-${card[4]}`}>
              <Icon name={card[3]} />
            </div>
            <div>
              <small>{card[0]}</small>
              <strong>{card[1]}</strong>
              <span>{card[2]}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="dashboard-grid">
        <section className="surface revenue-card">
          <div className="section-head">
            <div>
              <h2>Cash flow by month</h2>
              <p>Paid invoices vs expenses (last 6 months)</p>
            </div>
            <button
              className="btn secondary compact"
              onClick={() => navigate("/forecast")}
            >
              Forecast
            </button>
          </div>
          <div className="mini-bars">
            {bars.map((m: any) => (
              <div className="mini-bar-col" key={m.month}>
                <span
                  className="mb-rev"
                  style={{ height: `${barHeight(m.revenue)}%` }}
                  title={`Revenue ${money(m.revenue)}`}
                />
                <span
                  className="mb-exp"
                  style={{ height: `${barHeight(m.expenses)}%` }}
                  title={`Expenses ${money(m.expenses)}`}
                />
                <small>{m.label}</small>
              </div>
            ))}
          </div>
        </section>
        <section className="surface activities-widget">
          <div className="section-head">
            <div>
              <h2>Quick actions</h2>
              <p>Jump into the finance modules</p>
            </div>
          </div>
          <div className="record-count-grid">
            {[
              ["Invoices", finance?.unpaidCount || 0, "invoice", "/invoices"],
              ["Expenses", currentExpenses, "reports", "/expenses"],
              ["Revenue forecast", 0, "trend", "/forecast"],
            ].map(([label, count, icon, path]) => (
              <button
                key={String(label)}
                className="record-count"
                onClick={() => navigate(String(path))}
              >
                <Icon name={String(icon)} />
                <b>{typeof count === "number" && count > 0 ? count : ""}</b>
                <span>{label}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function ForecastPage() {
  const navigate = useNavigate();
  const [deals, setDeals] = useState<Row[]>([]);
  const [pipeline, setPipeline] = useState<any[]>([]);
  const [range, setRange] = useState<"6" | "12" | "custom">("6");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  useEffect(() => {
    Promise.all([api<any>("/deals?limit=1000"), api<any>("/pipeline")])
      .then(([dealResult, pipelineResult]) => {
        const dealItems = Array.isArray(dealResult)
          ? dealResult
          : dealResult?.items || [];
        setDeals(dealItems);

        const pipelineItems = Array.isArray(pipelineResult)
          ? pipelineResult
          : pipelineResult?.stages || [];
        setPipeline(pipelineItems);
      })
      .catch(() => {});
  }, []);

  const stageProbability = new Map<string, number>();

  pipeline.forEach((stage: any) => {
    const name = String(stage.name || stage.id || "").toLowerCase();
    const probability = Number(stage.probability);

    if (name) {
      stageProbability.set(
        name,
        Number.isFinite(probability) ? probability : 0,
      );
    }
  });

  const probabilityFor = (stage: string) => {
    const normalized = String(stage || "").toLowerCase();

    if (stageProbability.has(normalized)) {
      return stageProbability.get(normalized) || 0;
    }

    if (normalized === "won") return 100;
    if (normalized === "lost") return 0;

    return 0;
  };

  const now = new Date();

  function monthKey(date: Date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function monthLabel(key: string) {
    const [year, month] = key.split("-").map(Number);

    return new Intl.DateTimeFormat("en", {
      month: "short",
      year: "numeric",
    }).format(new Date(year, month - 1, 1));
  }

  function addMonths(date: Date, amount: number) {
    return new Date(date.getFullYear(), date.getMonth() + amount, 1);
  }

  const defaultMonths = range === "12" ? 12 : 6;

  let fromDate =
    range === "custom" && customFrom
      ? new Date(`${customFrom}T00:00:00`)
      : addMonths(
          new Date(now.getFullYear(), now.getMonth(), 1),
          -defaultMonths + 1,
        );

  let toDate =
    range === "custom" && customTo
      ? new Date(`${customTo}T23:59:59`)
      : new Date(
          now.getFullYear(),
          now.getMonth() + defaultMonths,
          0,
          23,
          59,
          59,
        );

  if (Number.isNaN(fromDate.getTime())) {
    fromDate = addMonths(new Date(now.getFullYear(), now.getMonth(), 1), -5);
  }

  if (Number.isNaN(toDate.getTime())) {
    toDate = new Date(now.getFullYear(), now.getMonth() + 6, 0, 23, 59, 59);
  }

  const months: string[] = [];
  let cursor = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);
  const end = new Date(toDate.getFullYear(), toDate.getMonth(), 1);

  while (cursor <= end && months.length < 36) {
    months.push(monthKey(cursor));
    cursor = addMonths(cursor, 1);
  }

  const chartData = months.map((month) => {
    const historicalWon = deals
      .filter((deal) => {
        if (String(deal.stage || "").toLowerCase() !== "won") {
          return false;
        }

        const date = new Date(deal.updatedAt || deal.createdAt || "");
        return !Number.isNaN(date.getTime()) && monthKey(date) === month;
      })
      .reduce((sum, deal) => sum + Number(deal.value || 0), 0);

    const pipelineDeals = deals.filter((deal) => {
      const stage = String(deal.stage || "").toLowerCase();

      if (stage === "won" || stage === "lost") {
        return false;
      }

      if (!deal.closeDate) {
        return false;
      }

      const date = new Date(`${String(deal.closeDate).slice(0, 10)}T00:00:00`);

      return !Number.isNaN(date.getTime()) && monthKey(date) === month;
    });

    const pipelineValue = pipelineDeals.reduce(
      (sum, deal) => sum + Number(deal.value || 0),
      0,
    );

    const weightedPipeline = pipelineDeals.reduce((sum, deal) => {
      const value = Number(deal.value || 0);
      const probability = probabilityFor(deal.stage);

      return sum + value * (probability / 100);
    }, 0);

    const averageProbability =
      pipelineValue > 0 ? (weightedPipeline / pipelineValue) * 100 : 0;

    return {
      month,
      label: monthLabel(month),
      historical: historicalWon,
      pipeline: weightedPipeline,
      rawPipeline: pipelineValue,
      probability: averageProbability,
    };
  });

  const totalHistorical = chartData.reduce(
    (sum, item) => sum + item.historical,
    0,
  );

  const totalForecast = chartData.reduce((sum, item) => sum + item.pipeline, 0);

  return (
    <div className="page">
      <PageHeader
        title="Revenue Forecast"
        description="Historical won revenue and probability-weighted pipeline forecast."
      />

      <section className="surface">
        <div
          className="section-head"
          style={{
            alignItems: "flex-start",
            gap: "16px",
            flexWrap: "wrap",
          }}
        >
          <div>
            <h2>Revenue forecast</h2>
            <p>Won revenue vs probability-weighted pipeline by month.</p>
          </div>

          <div
            style={{
              display: "flex",
              gap: "8px",
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            {(["6", "12", "custom"] as const).map((value) => (
              <button
                key={value}
                className={`btn ${range === value ? "primary" : "secondary"}`}
                onClick={() => setRange(value)}
              >
                {value === "6"
                  ? "Last 6 months"
                  : value === "12"
                    ? "Last 12 months"
                    : "Custom"}
              </button>
            ))}
          </div>
        </div>

        {range === "custom" ? (
          <div
            style={{
              display: "flex",
              gap: "12px",
              flexWrap: "wrap",
              marginBottom: "20px",
            }}
          >
            <label>
              <span>From</span>
              <input
                className="input"
                type="date"
                value={customFrom}
                onChange={(event) => setCustomFrom(event.target.value)}
              />
            </label>

            <label>
              <span>To</span>
              <input
                className="input"
                type="date"
                value={customTo}
                onChange={(event) => setCustomTo(event.target.value)}
              />
            </label>
          </div>
        ) : null}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: "12px",
            marginBottom: "20px",
          }}
        >
          <div className="surface">
            <small>Historical won revenue</small>
            <h3>{money(totalHistorical)}</h3>
          </div>

          <div className="surface">
            <small>Weighted pipeline</small>
            <h3>{money(totalForecast)}</h3>
          </div>
        </div>

        {chartData.length > 0 ? (
          <div style={{ width: "100%", height: 420 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={chartData}
                margin={{
                  top: 20,
                  right: 20,
                  left: 10,
                  bottom: 10,
                }}
              >
                <CartesianGrid strokeDasharray="3 3" />

                <XAxis dataKey="label" />

                <YAxis tickFormatter={(value) => money(value)} />

                <Tooltip
                  formatter={(value: any, name: any, item: any) => {
                    if (name === "pipeline") {
                      return [
                        money(Number(value)),
                        `Weighted pipeline (${Number(item?.payload?.probability || 0).toFixed(0)}%)`,
                      ];
                    }

                    return [
                      money(Number(value)),
                      name === "historical" ? "Historical won revenue" : name,
                    ];
                  }}
                />

                <Legend />

                <Bar
                  dataKey="pipeline"
                  name="Pipeline forecast"
                  fill="#8b5cf6"
                  fillOpacity={0.65}
                  radius={[4, 4, 0, 0]}
                />

                <Line
                  type="monotone"
                  dataKey="historical"
                  name="Historical won revenue"
                  stroke="#10b981"
                  strokeWidth={3}
                  dot={{ r: 4 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <Empty
            icon="trend"
            title="No forecast data"
            text="Add deals with values and close dates to build the revenue forecast."
            action={
              <button
                className="btn primary compact"
                onClick={() => navigate("/pipeline")}
              >
                Open pipeline
              </button>
            }
          />
        )}
      </section>
    </div>
  );
}

function ReportsPage() {
  const leads = useResource<Row>("leads");
  const deals = useResource<Row>("deals");
  const calls = useResource<Row>("calls");
  const tasks = useResource<Row>("tasks");
  const { toast } = useApp();
  const byStage = stages.map((stage) => ({
    ...stage,
    count: deals.items.filter((x) => (x.stage || "new") === stage.id).length,
    value: deals.items
      .filter((x) => (x.stage || "new") === stage.id)
      .reduce((sum, x) => sum + Number(x.value || 0), 0),
  }));
  function exportReport() {
    const text = [
      "Metric,Value",
      `Leads,${leads.items.length}`,
      `Deals,${deals.items.length}`,
      `Calls,${calls.items.length}`,
      `Open tasks,${tasks.items.filter((x) => x.status !== "Completed").length}`,
      ...byStage.map((x) => `${x.label} deals,${x.count}`),
    ].join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "tunaxa-report.csv";
    a.click();
    URL.revokeObjectURL(url);
    toast("Report exported");
  }
  const hasData =
    leads.items.length +
      deals.items.length +
      calls.items.length +
      tasks.items.length >
    0;
  return (
    <div className="page">
      <PageHeader
        title="Reports"
        description="Track pipeline, activity and team performance."
      >
        <button
          className="btn secondary"
          disabled={!hasData}
          onClick={exportReport}
        >
          <Icon name="download" /> Export CSV
        </button>
      </PageHeader>
      <CustomReportBuilder />
      <div className="stats-grid">
        <div className="stat-card hover-crm-card relative">
          <CornerBrackets stroke="#3b82f6" size="sm" />
          <div className="stat-icon tone-blue">
            <Icon name="lead" />
          </div>
          <div>
            <small>Total leads</small>
            <strong>{leads.items.length}</strong>
            <span>All lead records</span>
          </div>
        </div>
        <div className="stat-card hover-crm-card relative">
          <CornerBrackets stroke="#3b82f6" size="sm" />
          <div className="stat-icon tone-green">
            <Icon name="pipeline" />
          </div>
          <div>
            <small>Total deals</small>
            <strong>{deals.items.length}</strong>
            <span>
              {money(deals.items.reduce((s, x) => s + Number(x.value || 0), 0))}{" "}
              total value
            </span>
          </div>
        </div>
        <div className="stat-card hover-crm-card relative">
          <CornerBrackets stroke="#3b82f6" size="sm" />
          <div className="stat-icon tone-purple">
            <Icon name="phone" />
          </div>
          <div>
            <small>Calls logged</small>
            <strong>{calls.items.length}</strong>
            <span>Inbound and outbound</span>
          </div>
        </div>
        <div className="stat-card hover-crm-card relative">
          <CornerBrackets stroke="#3b82f6" size="sm" />
          <div className="stat-icon tone-amber">
            <Icon name="tasks" />
          </div>
          <div>
            <small>Open tasks</small>
            <strong>
              {tasks.items.filter((x) => x.status !== "Completed").length}
            </strong>
            <span>Needs attention</span>
          </div>
        </div>
      </div>
      <section className="surface report-table">
        <div className="section-head">
          <div>
            <h2>Pipeline by stage</h2>
            <p>Count and value</p>
          </div>
        </div>
        {deals.items.length ? (
          byStage.map((row) => (
            <div className="report-row" key={row.id}>
              <span>{row.label}</span>
              <div className="bar-track">
                <i
                  style={{
                    width: `${Math.max(4, (row.count / deals.items.length) * 100)}%`,
                  }}
                />
              </div>
              <b>{row.count}</b>
              <strong>{money(row.value)}</strong>
            </div>
          ))
        ) : (
          <Empty
            icon="reports"
            title="No report data"
            text="Add leads, deals, calls or tasks and reporting will populate automatically."
          />
        )}
      </section>
    </div>
  );
}

function AuditPage() {
  const { toast } = useApp();
  const [items, setItems] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ items: Row[] }>("/audit")
      .then((result) => setItems(result.items))
      .catch((error) => toast((error as Error).message, "error"))
      .finally(() => setLoading(false));
  }, [toast]);

  return (
    <div className="page">
      <PageHeader
        title="Audit log"
        description="Review workspace changes and request details."
      />
      <section className="surface table-surface">
        {loading ? (
          <div className="table-loading">Loading…</div>
        ) : items.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Actor</th>
                  <th>Created</th>
                  <th>IP</th>
                  <th>User agent</th>
                  <th>Resource ID</th>
                </tr>
              </thead>
              <tbody>
                {items.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.action || "—"}</td>
                    <td>{entry.actor || "—"}</td>
                    <td>
                      {entry.createdAt
                        ? new Date(entry.createdAt).toLocaleString()
                        : "—"}
                    </td>
                    <td>{entry.ip || "—"}</td>
                    <td>{entry.userAgent || "—"}</td>
                    <td>{entry.resourceId || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            icon="shield"
            title="No audit entries"
            text="Workspace activity will appear here."
          />
        )}
      </section>
    </div>
  );

}

function TeamPage() {
  const { toast } = useApp();
  const { items, loading, update, remove } = useResource<Row>("team");
  const [edit, setEdit] = useState<Row | undefined>();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteSent, setInviteSent] = useState("");
  const [inviteError, setInviteError] = useState("");
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [invitationsLoading, setInvitationsLoading] = useState(true);
  const [invitationsError, setInvitationsError] = useState("");
  const [resending, setResending] = useState("");
  const fields: FieldSpec[] = [
    { key: "avatar", label: "Photo", type: "photo" },
    { key: "name", label: "Name" },
    { key: "email", label: "Email", type: "email" },
    {
      key: "role",
      label: "Role",
      type: "select",
      options: ["Owner", "Manager", "Sales rep", "RevOps", "Viewer"],
    },
    {
      key: "status",
      label: "Status",
      type: "select",
      options: ["Active", "Invited", "Disabled"],
    },
  ];
  const fieldsForForm = fields.filter((f) => f.key !== "avatar");
  const avatarField = fields.find((f) => f.key === "avatar")!;

  async function loadInvitations() {
    setInvitationsLoading(true);
    setInvitationsError("");
    try {
      const response = await api<unknown>("/users/invites");
      setInvitations(normalizeInvitations(response));
    } catch (error) {
      setInvitationsError((error as Error).message);
    } finally {
      setInvitationsLoading(false);
    }
  }

  useEffect(() => {
    void loadInvitations();
  }, []);

  function openInvite() {
    setInviteEmail("");
    setInviteSent("");
    setInviteError("");
    setInviteOpen(true);
  }

  async function sendInvitation(event: FormEvent) {
    event.preventDefault();
    const email = inviteEmail.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setInviteError("Enter a valid email address.");
      return;
    }

    setInviteBusy(true);
    setInviteError("");
    try {
      await api("/users/invite", json("POST", { email }));
      setInviteSent(email);
      toast("Invitation sent");
      await loadInvitations();
    } catch (error) {
      setInviteError((error as Error).message);
    } finally {
      setInviteBusy(false);
    }
  }

  async function resendInvitation(invitation: PendingInvitation) {
    setResending(invitation.id);
    setInvitationsError("");
    try {
      await api(
        "/users/invite",
        json("POST", { email: invitation.email }),
      );
      toast(`Invitation resent to ${invitation.email}`);
      await loadInvitations();
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setResending("");
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Team & Roles"
        description="Workspace members and role assignments."
      >
        <button className="btn primary" onClick={openInvite}>
          <Icon name="send" /> Invite member
        </button>
      </PageHeader>

      <section className="surface team-invitations" aria-labelledby="pending-invitations-title">
        <header className="team-invitations-head">
          <div>
            <h2 id="pending-invitations-title">Pending invitations</h2>
            <p>Invitations that have not been accepted yet.</p>
          </div>
          <Badge tone="blue">{invitations.length} pending</Badge>
        </header>

        {invitationsLoading ? (
          <div className="team-invitations-state" aria-live="polite">
            Loading invitations…
          </div>
        ) : invitationsError ? (
          <div className="team-invitations-error" role="alert">
            <div>
              <b>Could not load pending invitations</b>
              <span>{invitationsError}</span>
            </div>
            <button
              className="btn secondary compact"
              type="button"
              onClick={() => void loadInvitations()}
            >
              Try again
            </button>
          </div>
        ) : invitations.length ? (
          <div className="team-invitation-list">
            {invitations.map((invitation) => {
              const expired = invitationIsExpired(invitation.expiresAt);
              const expiry = invitation.expiresAt
                ? new Date(invitation.expiresAt)
                : null;
              const validExpiry = expiry && !Number.isNaN(expiry.getTime());
              return (
                <article className="team-invitation-row" key={invitation.id}>
                  <span className="team-invitation-icon">
                    <Icon name="mail" />
                  </span>
                  <div className="team-invitation-copy">
                    <b>{invitation.email}</b>
                    <span>
                      <Icon name="clock" size={13} />
                      {validExpiry ? (
                        <time dateTime={invitation.expiresAt}>
                          {expired ? "Expired " : "Expires "}
                          {expiry.toLocaleString()}
                        </time>
                      ) : (
                        "Expiry unavailable"
                      )}
                    </span>
                  </div>
                  <Badge tone={expired ? "amber" : "blue"}>
                    {expired ? "Expired" : "Pending"}
                  </Badge>
                  <button
                    className="btn secondary compact"
                    type="button"
                    disabled={resending === invitation.id}
                    onClick={() => void resendInvitation(invitation)}
                  >
                    {resending === invitation.id ? "Sending…" : "Resend"}
                  </button>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="team-invitations-state empty">
            <Icon name="checkCircle" size={21} />
            <span>No pending invitations</span>
          </div>
        )}
      </section>

      <section className="surface table-surface">
        {loading ? (
          <div className="table-loading">Loading…</div>
        ) : items.length ? (
          <table>
            <thead>
              <tr>
                <th>Member</th>
                <th>Role</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((member) => (
                <tr key={member.id}>
                  <td>
                    <div className="person-cell">
                      <Avatar src={member.avatar} name={member.name || "NX"} />
                      <div>
                        <b>{member.name}</b>
                        <small>{member.email}</small>
                      </div>
                    </div>
                  </td>
                  <td>
                    <Badge tone={member.role === "Owner" ? "purple" : "blue"}>
                      {member.role || "Viewer"}
                    </Badge>
                  </td>
                  <td>
                    <Badge
                      tone={member.status === "Active" ? "green" : "neutral"}
                    >
                      {member.status || "Invited"}
                    </Badge>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="icon-btn tiny"
                        aria-label={`Edit ${member.name || member.email || "team member"}`}
                        onClick={() => setEdit(member)}
                      >
                        <Icon name="edit" />
                      </button>
                      {member.role !== "Owner" ? (
                        <button
                          className="icon-btn tiny danger-link"
                          aria-label={`Remove ${member.name || member.email || "team member"}`}
                          onClick={() =>
                            confirm("Remove this member?") && remove(member.id)
                          }
                        >
                          <Icon name="trash" />
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty
            icon="team"
            title="No team members"
            text="Add members and assign roles."
            action={
              <button
                className="btn primary compact"
                onClick={openInvite}
              >
                Invite member
              </button>
            }
          />
        )}
      </section>

      {edit !== undefined ? (
        <RecordForm
          title="Edit team member"
          fields={[avatarField, ...fieldsForForm]}
          initial={edit}
          onClose={() => setEdit(undefined)}
          onSave={async (data) => {
            await update(edit.id, data);
            setEdit(undefined);
          }}
        />
      ) : null}

      {inviteOpen ? (
        <Modal
          title={inviteSent ? "Invitation sent" : "Invite a team member"}
          onClose={() => !inviteBusy && setInviteOpen(false)}
          footer={
            inviteSent ? (
              <>
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() => {
                    setInviteEmail("");
                    setInviteSent("");
                    setInviteError("");
                  }}
                >
                  Invite another
                </button>
                <button
                  className="btn primary"
                  type="button"
                  onClick={() => setInviteOpen(false)}
                >
                  Done
                </button>
              </>
            ) : (
              <>
                <button
                  className="btn secondary"
                  type="button"
                  disabled={inviteBusy}
                  onClick={() => setInviteOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className="btn primary"
                  type="submit"
                  form="team-invite-form"
                  disabled={inviteBusy}
                >
                  <Icon name="send" />
                  {inviteBusy ? "Sending…" : "Send invitation"}
                </button>
              </>
            )
          }
        >
          {inviteSent ? (
            <div className="team-invite-success" role="status">
              <span>
                <Icon name="check" size={27} />
              </span>
              <h4>Invitation sent</h4>
              <p>
                An invitation was sent to <b>{inviteSent}</b>.
              </p>
            </div>
          ) : (
            <form id="team-invite-form" className="team-invite-form" onSubmit={sendInvitation}>
              <div className="team-invite-intro">
                <span>
                  <Icon name="mail" size={22} />
                </span>
                <div>
                  <b>Invite by email</b>
                  <p>The new member will receive a link to join this workspace.</p>
                </div>
              </div>
              <label className="field">
                <span>Email address</span>
                <input
                  autoFocus
                  type="email"
                  value={inviteEmail}
                  placeholder="teammate@company.com"
                  autoComplete="email"
                  onChange={(event) => {
                    setInviteEmail(event.target.value);
                    setInviteError("");
                  }}
                />
              </label>
              {inviteError ? (
                <p className="inline-alert error" role="alert">
                  <Icon name="warning" /> {inviteError}
                </p>
              ) : null}
            </form>
          )}
        </Modal>
      ) : null}
    </div>
  );
}

function FieldsPage() {
  const { items, create, update, remove } = useResource<Row>("customFields");
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  const fields: FieldSpec[] = [
    {
      key: "object",
      label: "CRM object",
      type: "select",
      options: ["Lead", "Contact", "Company", "Deal"],
    },
    { key: "name", label: "Field name" },
    { key: "key", label: "Field key" },
    {
      key: "type",
      label: "Field type",
      type: "select",
      options: ["Text", "Number", "Date", "Dropdown", "Checkbox", "Currency"],
    },
    {
      key: "options",
      label: "Dropdown options (comma separated)",
      type: "textarea",
      placeholder: "Option A, Option B",
    },
  ];
  return (
    <div className="page">
      <PageHeader
        title="Custom Fields & Objects"
        description="Create custom properties for your CRM records."
      >
        <button className="btn primary" onClick={() => setEdit(null)}>
          <Icon name="plus" /> New field
        </button>
      </PageHeader>
      <section className="surface field-table">
        {items.length ? (
          <table>
            <thead>
              <tr>
                <th>Object</th>
                <th>Field</th>
                <th>Key</th>
                <th>Type</th>
                <th>Required</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <Badge>{item.object}</Badge>
                  </td>
                  <td>
                    <b>{item.name}</b>
                  </td>
                  <td>
                    <code>{item.key}</code>
                  </td>
                  <td>{item.type}</td>
                  <td>
                    <Toggle
                      label={`Make ${item.name || "field"} ${item.required ? "optional" : "required"}`}
                      value={Boolean(item.required)}
                      onChange={(required) => update(item.id, { required })}
                    />
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="icon-btn tiny"
                        aria-label={`Edit ${item.name || "custom field"}`}
                        onClick={() => setEdit(item)}
                      >
                        <Icon name="edit" />
                      </button>
                      <button
                        className="icon-btn tiny danger-link"
                        aria-label={`Delete ${item.name || "custom field"}`}
                        onClick={() =>
                          confirm("Delete this custom field?") &&
                          remove(item.id)
                        }
                      >
                        <Icon name="trash" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty
            icon="fields"
            title="No custom fields"
            text="Create fields for leads, contacts, companies or deals."
            action={
              <button
                className="btn primary compact"
                onClick={() => setEdit(null)}
              >
                New field
              </button>
            }
          />
        )}
      </section>
      {edit !== undefined ? (
        <RecordForm
          title={`${edit ? "Edit" : "New"} custom field`}
          fields={fields}
          initial={edit || { object: "Lead", type: "Text" }}
          onClose={() => setEdit(undefined)}
          onSave={async (data) => {
            const normalized = {
              ...data,
              key:
                data.key ||
                String(data.name || "")
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "_")
                  .replace(/^_|_$/g, ""),
            };
            edit
              ? await update(edit.id, normalized)
              : await create({ ...normalized, required: false });
            setEdit(undefined);
          }}
        />
      ) : null}
    </div>
  );
}

function TemplatesManager() {
  const { toast } = useApp();
  const [templates, setTemplates] = useState<Row[]>([]);
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);

  useEffect(() => {
    api<Row[]>("/templates")
      .then(setTemplates)
      .catch(() => {});
  }, []);

  async function save(data: Record<string, any>) {
    try {
      if (edit?.id) {
        await api(`/templates/${edit.id}`, json("PUT", data));
        setTemplates((prev) =>
          prev.map((t) => (t.id === edit.id ? { ...t, ...data } : t)),
        );
      } else {
        const created = await api<Row>("/templates", json("POST", data));
        setTemplates((prev) => [created, ...prev]);
      }
      setEdit(undefined);
      toast(edit?.id ? "Template updated" : "Template created");
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  async function removeTemplate(tpl: Row) {
    if (!confirm(`Delete template "${tpl.name}"?`)) return;
    try {
      await api(`/templates/${tpl.id}`, { method: "DELETE" });
      setTemplates((prev) => prev.filter((t) => t.id !== tpl.id));
      toast("Template deleted");
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  return (
    <>
      <h3 className="settings-section">Email templates</h3>
      {templates.length ? (
        <div className="template-list">
          {templates.map((t) => (
            <div className="template-card" key={t.id}>
              <div>
                <b>{t.name}</b>
                <small>{t.subject}</small>
              </div>
              <div className="row-actions">
                <button
                  className="icon-btn tiny"
                  aria-label={`Edit ${t.name || "template"}`}
                  onClick={() => setEdit(t)}
                >
                  <Icon name="edit" />
                </button>
                <button
                  className="icon-btn tiny danger-link"
                  aria-label={`Delete ${t.name || "template"}`}
                  onClick={() => removeTemplate(t)}
                >
                  <Icon name="trash" />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="settings-hint">
          No templates yet. Create your first email template for quick reuse.
        </p>
      )}
      <button className="btn secondary compact" onClick={() => setEdit(null)}>
        <Icon name="plus" /> Add template
      </button>
      {edit !== undefined ? (
        <RecordForm
          title={edit?.id ? "Edit template" : "New template"}
          fields={[
            { key: "name", label: "Template name", required: true },
            { key: "subject", label: "Subject", required: true },
            { key: "body", label: "Body", type: "textarea", required: true },
            {
              key: "channel",
              label: "Channel",
              type: "select",
              options: ["Email", "SMS"],
            },
          ]}
          initial={edit || { channel: "Email" }}
          onClose={() => setEdit(undefined)}
          onSave={save}
        />
      ) : null}
    </>
  );
}

function SettingsPage() {
  const { toast } = useApp();
  const [tab, setTab] = useState("Workspace");
  const [settings, setSettings] = useState<Record<string, any> | null>(null);
  const {
  register,
  handleSubmit,
  reset,
  watch,
  setValue,
} = useForm<Record<string, any>>({
  defaultValues: {},
});
  useEffect(() => {
  api<Record<string, any>>("/settings")
    .then((data) => {
      setSettings(data);
      reset(data);
    })
    .catch((error) => toast(error.message, "error"));
}, [reset]);
  if (!settings)
    return (
      <div className="page">
        <PageHeader title="Settings" />
        <section className="surface settings-card">Loading…</section>
      </div>
    );
  function set(key: string, value: any) {
    setSettings((current) =>
      current ? { ...current, [key]: value } : current,
    );
  }
 async function save(data: Record<string, any>) {
  try {
    const saved = await api<Record<string, any>>(
      "/settings",
      json("PUT", data),
    );
    setSettings(saved);
    reset(saved);
    toast("Settings saved");
  } catch (error) {
    toast((error as Error).message, "error");
  }
}
  const tabs = [
    "Workspace",
    "Calling",
    "Email & SMS",
    "AI & coaching",
    "Integrations",
    "Data & security",
  ];
  const input = (
  key: string,
  label: string,
  options?: { type?: string; placeholder?: string; span2?: boolean },
) => (
  <label className={`field ${options?.span2 ? "span-2" : ""}`}>
    <span>{label}</span>
    <input
      type={options?.type || "text"}
      {...register(key)}
      placeholder={options?.placeholder}
    />
  </label>
);

  return (
    <div className="page">
      <PageHeader
        title="Settings"
        description="Manage your workspace preferences and integrations."
      >
        <button className="btn primary" onClick={handleSubmit(save)}>
  Save changes
</button>
      </PageHeader>
      <div className="settings-layout">
        <aside className="settings-nav">
          {tabs.map((item) => (
            <button
              key={item}
              className={tab === item ? "active" : ""}
              onClick={() => setTab(item)}
            >
              <Icon
                name={
                  item === "Calling"
                    ? "phone"
                    : item === "Email & SMS"
                      ? "inbox"
                      : item === "AI & coaching"
                        ? "ai"
                        : item === "Integrations"
                          ? "globe"
                          : item === "Data & security"
                            ? "shield"
                            : "settings"
                }
              />
              {item}
            </button>
          ))}
        </aside>
        <main className="settings-main">
          <section className="surface settings-card">
            {tab === "Workspace" ? (
              <>
                <div className="workspace-brand-setting">
                  <div className="logo-preview">
                    <img src={logo} alt="Tunaxa" />
                  </div>
                  <div>
                    <b>Tunaxa</b>
                    <p>Logo loaded from public/assets/tunaxa-logo.png</p>
                  </div>
                </div>
                <div className="form-grid">
                  {input("workspaceName", "Workspace name")}
                  <label className="field">
                    <span>Language</span>
                    <select
                      value={i18n.language === "fr" ? "fr" : "en"}
                      onChange={(e) => {
                        i18n.changeLanguage(e.target.value);
                        localStorage.setItem("tunaxa.language", e.target.value);
                      }}
                    >
                      <option value="en">English</option>
                      <option value="fr">Français</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Currency</span>
                    <select {...register("currency")}>
                      <option>USD</option>
                      <option>EUR</option>
                      <option>TND</option>
                    </select>
                  </label>
                  {input("timezone", "Timezone")}
                  <label className="field">
                    <span>Week starts</span>
                    <select {...register("weekStarts")}>
                      <option>Monday</option>
                      <option>Sunday</option>
                    </select>
                  </label>
                </div>
              </>
            ) : null}
            {tab === "Calling" ? (
              <>
                <Setting
                 title="Automatic call recording"
                 text="Default recording preference for new calls."
                 value={Boolean(watch("callRecording"))}
                 onChange={(v) => setValue("callRecording", v)}
                />
                <Setting
  title="Local presence"
  text="Use a matching local outbound number when your provider supports it."
  value={Boolean(watch("localPresence"))}
  onChange={(v) => setValue("localPresence", v)}
/>
               <Setting
  title="Voicemail detection"
  text="Enable voicemail detection for a connected provider."
  value={Boolean(watch("voicemailDetection"))}
  onChange={(v) => setValue("voicemailDetection", v)}
/>
                <h3 className="settings-section">Twilio telephony</h3>
                <div className="form-grid">
                  {input("twilioSid", "Account SID", { placeholder: "AC…" })}
                  {input("twilioToken", "Auth token", { type: "password" })}
                  {input("twilioNumber", "Twilio number (E.164)", {
                    placeholder: "+216…",
                    span2: true,
                  })}
                  {input("publicBaseUrl", "Public base URL for webhooks", {
                    placeholder: "https://your-domain.example",
                    span2: true,
                  })}
                </div>
                <p className="settings-hint">
                  The public base URL must be reachable by Twilio (tunnel or
                  hosted server) so callbacks reach /api/twilio/voice,
                  /api/twilio/status and /api/twilio/recording.
                </p>
              </>
            ) : null}
            {tab === "Email & SMS" ? (
              <>
                <Setting
                  title="Email tracking"
                  text="Track opens and clicks when supported by your provider."
                  value={Boolean(watch("emailTracking"))}
                  onChange={(v) => setValue("emailTracking", v)}
                />
                <Setting
                  title="Two-way SMS"
                  text="Allow replies through a connected SMS provider."
                 value={Boolean(watch("twoWaySms"))}
                 onChange={(v) => setValue("twoWaySms", v)}
                />
                <h3 className="settings-section">SMTP server</h3>
                <div className="form-grid">
                  {input("smtpHost", "SMTP host")}
                  {input("smtpPort", "SMTP port", { placeholder: "587" })}
                  {input("smtpUser", "Username")}
                  {input("smtpPass", "Password", { type: "password" })}
                  <label className="field">
                    <span>Connection security</span>
                    <select
                  {...register("smtpSecure", {
                  setValueAs: (value) => value === "true",
               })}
                >
                      <option value="false">STARTTLS (port 587)</option>
                      <option value="true">Direct SSL (port 465)</option>
                    </select>
                  </label>
                </div>
                <TemplatesManager />
              </>
            ) : null}
            {tab === "AI & coaching" ? (
              <>
               <Setting
  title="AI transcription"
  text="Enable transcription through a connected AI provider."
  value={Boolean(watch("aiTranscription"))}
  onChange={(v) => setValue("aiTranscription", v)}
/>
                <Setting
  title="Automatic summaries"
  text="Generate call summaries with AI after transcription."
  value={Boolean(watch("aiSummaries"))}
  onChange={(v) => setValue("aiSummaries", v)}
/>
                <Setting
  title="Auto-transcribe Twilio recordings"
  text="Transcribe incoming call recordings automatically."
  value={Boolean(watch("autoTranscribeRecordings"))}
  onChange={(v) => setValue("autoTranscribeRecordings", v)}
/>
               <Setting
  title="Deal risk"
  text="Enable deal-risk analysis."
  value={Boolean(watch("dealRisk"))}
  onChange={(v) => setValue("dealRisk", v)}
/>
               <Setting
  title="Real-time coaching"
  text="Enable live coaching integrations."
  value={Boolean(watch("realTimeCoaching"))}
  onChange={(v) => setValue("realTimeCoaching", v)}
/>
                <h3 className="settings-section">Ollama (local AI)</h3>
                <div className="form-grid">
                  {input("ollamaBaseUrl", "Server URL", {
                    placeholder: "http://localhost:11434",
                  })}
                  {input("ollamaTranscriptionModel", "Transcription model", {
                    placeholder: "whisper",
                  })}
                  {input("ollamaSummaryModel", "Summary model", {
                    placeholder: "gemma3:4b",
                    span2: true,
                  })}
                </div>
                <p className="settings-hint">
                  Run Ollama locally with <code>ollama serve</code>. Pull models
                  with <code>ollama pull whisper</code> and{" "}
                  <code>ollama pull gemma3:4b</code>. No API keys required.
                </p>
              </>
            ) : null}
            {tab === "Integrations" ? (
              <>
                <div className="integration-grid">
                  <article>
                    <span>
                      <Icon name="inbox" />
                    </span>
                    <div>
                      <b>SMTP email</b>
                      <small>
                        {settings.smtpHost ? "Configured" : "Not configured"}
                      </small>
                    </div>
                    <Badge tone={settings.smtpHost ? "green" : "amber"}>
                      {settings.smtpHost ? "Ready" : "Setup"}
                    </Badge>
                  </article>
                  <article>
                    <span>
                      <Icon name="phone" />
                    </span>
                    <div>
                      <b>Twilio</b>
                      <small>
                        {settings.twilioSid ? "Configured" : "Not configured"}
                      </small>
                    </div>
                    <Badge tone={settings.twilioSid ? "green" : "amber"}>
                      {settings.twilioSid ? "Ready" : "Setup"}
                    </Badge>
                  </article>
                  <article>
                    <span>
                      <Icon name="ai" />
                    </span>
                    <div>
                      <b>Ollama</b>
                      <small>
                        {settings.ollamaBaseUrl
                          ? "Configured"
                          : "Not configured"}
                      </small>
                    </div>
                    <Badge tone={settings.ollamaBaseUrl ? "green" : "amber"}>
                      {settings.ollamaBaseUrl ? "Ready" : "Setup"}
                    </Badge>
                  </article>
                </div>
                <p className="settings-hint">
                  Save your credentials in the Calling, Email &amp; SMS, and AI
                  tabs, then verify them here.
                </p>
              </>
            ) : null}
            {tab === "Data & security" ? (
              <>
                <div className="frontend-notice">
                  <Icon name="shield" />
                  <div>
                    <b>Local JSON storage</b>
                    <p>
                      Workspace records are stored in backend/data/db.json.
                      Passwords are salted and hashed with scrypt. Provider
                      media (recordings) is stored in backend/uploads or fetched
                      from the provider.
                    </p>
                  </div>
                </div>
                <button
                  className="btn secondary"
                  style={{ marginTop: 12 }}
                  onClick={() =>
                    navigator.clipboard
                      .writeText("backend/data/db.json")
                      .then(() => toast("Database path copied"))
                  }
                >
                  <Icon name="copy" /> Copy database path
                </button>
              </>
            ) : null}
          </section>
        </main>
      </div>
    </div>
  );
}

function Setting({
  title,
  text,
  value,
  onChange,
}: {
  title: string;
  text: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="setting-toggle">
      <div>
        <b>{title}</b>
        <p>{text}</p>
      </div>
      <Toggle label={title} value={Boolean(value)} onChange={onChange} />
    </div>
  );
}

const formFieldTypes = [
  "text",
  "email",
  "phone",
  "number",
  "date",
  "textarea",
  "select",
  "checkbox",
  "MultiSelect",
];
const blankFormField = () => ({
  key: "",
  name: "",
  type: "text",
  required: false,
});

function FormsPage() {
  const { toast } = useApp();
  const [forms, setForms] = useState<Row[]>([]);
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  const load = () =>
    api<{ data: Row[] }>("/forms")
      .then((result) => setForms(result.data || []))
      .catch((err) => toast(err.message, "error"));
  useEffect(() => {
    load();
    window.addEventListener("tunaxa:resource-changed", load);
    return () => window.removeEventListener("tunaxa:resource-changed", load);
  }, []);
  const publicBase = "http://127.0.0.1:3000";
  return (
    <SimpleCards
      title="Forms"
      description="Capture leads and contacts with embeddable web forms."
      icon="form"
      items={forms}
      onAdd={() => setEdit(null)}
      onEdit={setEdit}
      onDelete={async (id) => {
        try {
          await api(`/forms/${id}`, json("DELETE"));
          toast("Form deleted");
          load();
        } catch (error) {
          toast((error as Error).message, "error");
        }
      }}
      render={(f) => (
        <>
          <div className="deal-top">
            <Badge tone={f.enabled ? "green" : "neutral"}>
              {f.enabled ? "Enabled" : "Disabled"}
            </Badge>
            <span className="table-count">
              {f.submissionCount || 0} submissions
            </span>
          </div>
          <h3>{f.title || f.name}</h3>
          <p>{f.description || "No description"}</p>
          <small>
            {f.permalink}
            {f.fields?.length ? ` · ${f.fields.length} fields` : ""}
            {f.submitTo
              ? ` · ${f.submitTo === "contact" ? "Contacts" : "Leads"}`
              : ""}
          </small>
          {f.permalink ? (
            <button
              className="btn ghost compact"
              onClick={() =>
                navigator.clipboard
                  .writeText(`${publicBase}/api/forms/${f.permalink}`)
                  .then(() => toast("Form URL copied"))
              }
            >
              <Icon name="copy" /> Copy URL
            </button>
          ) : null}
        </>
      )}
      modal={
        edit !== undefined ? (
          <FormEditor
            initial={edit || null}
            onClose={() => setEdit(undefined)}
            onSaved={() => {
              load();
              setEdit(undefined);
            }}
          />
        ) : null
      }
    />
  );
}

function FormEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial: Row | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useApp();
  const [name, setName] = useState(initial?.name || "");
  const [title, setTitle] = useState(initial?.title || "");
  const [description, setDescription] = useState(initial?.description || "");
  const [submitTo, setSubmitTo] = useState(initial?.submitTo || "lead");
  const [progressive, setProgressive] = useState(
    initial?.progressive !== false,
  );
  const [redirectUrl, setRedirectUrl] = useState(initial?.redirectUrl || "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [fields, setFields] = useState<Record<string, any>[]>(
    initial?.fields?.length
      ? (initial.fields as any[]).map((f) => ({
          key: f.key || "",
          name: f.name || f.label || "",
          type: f.type || "text",
          required: Boolean(f.required),
        }))
      : [blankFormField()],
  );
  const [busy, setBusy] = useState(false);
  function setField(index: number, patch: Record<string, any>) {
    setFields((current) =>
      current.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    );
  }
  async function save() {
    if (!String(name).trim()) return toast("Form name is required", "error");
    const valid = fields.filter((f) => String(f.key || "").trim());
    if (!valid.length) return toast("Add at least one form field", "error");
    const payload = {
      name: name.trim(),
      title: title.trim(),
      description: description.trim(),
      submitTo,
      progressive,
      redirectUrl: redirectUrl.trim(),
      enabled,
      fields: valid.map((f) => ({
        key: f.key.trim(),
        name: f.name || f.key.trim(),
        type: f.type || "text",
        required: Boolean(f.required),
      })),
    };
    setBusy(true);
    try {
      if (initial?.id) await api(`/forms/${initial.id}`, json("PUT", payload));
      else await api("/forms", json("POST", payload));
      toast(initial?.id ? "Form updated" : "Form created");
      onSaved();
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Drawer
      title={initial?.id ? "Edit form" : "New form"}
      subtitle="Build an embeddable web form that captures leads or contacts."
      onClose={onClose}
      width={760}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? "Saving…" : initial?.id ? "Save form" : "Create form"}
          </button>
        </>
      }
    >
      <div className="drawer-form">
        <label className="field">
          <span>Form name *</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Contact us form"
          />
        </label>
        <div className="form-grid">
          <label className="field">
            <span>Public title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Form title shown to visitors"
            />
          </label>
          <label className="field">
            <span>Save submissions to</span>
            <select
              value={submitTo}
              onChange={(e) => setSubmitTo(e.target.value)}
            >
              <option value="lead">Leads</option>
              <option value="contact">Contacts</option>
            </select>
          </label>
          <label className="field">
            <span>Redirect URL (after submit)</span>
            <input
              value={redirectUrl}
              onChange={(e) => setRedirectUrl(e.target.value)}
              placeholder="https://…"
            />
          </label>
          <label className="field">
            <span>Description</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short description"
            />
          </label>
        </div>
        <div className="setting-toggle">
          <div>
            <b>Enable form</b>
            <p>Visitors can see and submit this form.</p>
          </div>
          <Toggle label="Enable form" value={enabled} onChange={setEnabled} />
        </div>
        <div className="setting-toggle">
          <div>
            <b>Progressive profiling</b>
            <p>Hide fields the visitor has already answered.</p>
          </div>
          <Toggle
            label="Progressive profiling"
            value={progressive}
            onChange={setProgressive}
          />
        </div>
        <h4>Form fields</h4>
        {fields.map((field, i) => (
          <div className="form-field-editor" key={i}>
            <label className="field">
              <span>Field label</span>
              <input
                value={field.name}
                onChange={(e) => setField(i, { name: e.target.value })}
                placeholder="e.g. Email address"
              />
            </label>
            <label className="field">
              <span>Field key</span>
              <input
                value={field.key}
                onChange={(e) => setField(i, { key: e.target.value })}
                placeholder="e.g. email"
              />
            </label>
            <label className="field">
              <span>Type</span>
              <select
                value={field.type}
                onChange={(e) => setField(i, { type: e.target.value })}
              >
                {formFieldTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <div className="toggle-row">
              <input
                type="checkbox"
                aria-label={`${field.name || `Field ${i + 1}`} required`}
                checked={Boolean(field.required)}
                onChange={(e) => setField(i, { required: e.target.checked })}
              />
              <span>Required</span>
            </div>
            <button
              className="btn ghost compact danger-link"
              onClick={() =>
                setFields((current) => current.filter((_, j) => j !== i))
              }
              disabled={fields.length === 1}
            >
              <Icon name="trash" /> Remove
            </button>
          </div>
        ))}
        <button
          className="btn secondary compact"
          onClick={() => setFields((current) => [...current, blankFormField()])}
        >
          <Icon name="plus" /> Add field
        </button>
      </div>
    </Drawer>
  );
}

function WebhooksPage() {
  const { toast } = useApp();
  const { items, create, update, remove } =
    useResource<Row>("webhookEndpoints");
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  return (
    <SimpleCards
      title="Webhooks"
      description="Inbound webhook endpoints that trigger workflows."
      icon="webhook"
      items={items}
      onAdd={() => setEdit(null)}
      onEdit={setEdit}
      onDelete={remove}
      render={(item) => (
        <>
          <div className="deal-top">
            <Badge tone={item.enabled ? "green" : "neutral"}>
              {item.enabled ? "Active" : "Disabled"}
            </Badge>
            <Toggle
              label={`${item.enabled ? "Disable" : "Enable"} ${item.name || "webhook endpoint"}`}
              value={Boolean(item.enabled)}
              onChange={(enabled) => update(item.id, { enabled })}
            />
          </div>
          <h3>{item.name || "Untitled endpoint"}</h3>
          <p>{item.description || "No description"}</p>
          <small>
            {item.requestCount || 0} requests ·{" "}
            {item.lastReceivedAt
              ? new Date(item.lastReceivedAt).toLocaleString()
              : "No deliveries yet"}
          </small>
          {item.url ? (
            <button
              className="btn ghost compact"
              onClick={() =>
                navigator.clipboard
                  .writeText(item.url)
                  .then(() => toast("Webhook URL copied"))
              }
            >
              <Icon name="copy" /> Copy URL
            </button>
          ) : null}
        </>
      )}
      modal={
        edit !== undefined ? (
          <WebhookEditor
            initial={edit || null}
            onClose={() => setEdit(undefined)}
            onSave={async (data) => {
              edit ? await update(edit.id, data) : await create(data);
              setEdit(undefined);
            }}
          />
        ) : null
      }
    />
  );
}

function WebhookEditor({
  initial,
  onClose,
  onSave,
}: {
  initial: Row | null;
  onClose: () => void;
  onSave: (data: Record<string, any>) => Promise<void>;
}) {
  const { toast } = useApp();
  const [name, setName] = useState(initial?.name || "");
  const [description, setDescription] = useState(initial?.description || "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!String(name).trim())
      return toast("Endpoint name is required", "error");
    setBusy(true);
    try {
      await onSave({
        name: name.trim(),
        description: description.trim(),
        enabled,
      });
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Drawer
      title={initial?.id ? "Edit webhook" : "New webhook"}
      subtitle="A URL you can POST JSON payloads to in order to trigger workflows."
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? "Saving…" : initial?.id ? "Save webhook" : "Create webhook"}
          </button>
        </>
      }
    >
      <div className="drawer-form">
        <label className="field">
          <span>Endpoint name *</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Product signup webhook"
          />
        </label>
        <label className="field">
          <span>Description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="What triggers this webhook?"
          />
        </label>
        <div className="setting-toggle">
          <div>
            <b>Enabled</b>
            <p>Accept inbound deliveries at this endpoint.</p>
          </div>
          <Toggle label="Enable webhook endpoint" value={enabled} onChange={setEnabled} />
        </div>
      </div>
    </Drawer>
  );
}

function SimpleCards({
  title,
  description,
  icon,
  items,
  onAdd,
  onEdit,
  onDelete,
  render,
  modal,
}: {
  title: string;
  description: string;
  icon: string;
  items: Row[];
  onAdd: () => void;
  onEdit: (row: Row) => void;
  onDelete: (id: string) => void;
  render: (row: Row) => ReactNode;
  modal?: ReactNode;
}) {
  const singular =
    title === "Activities" ? "activity" : title.slice(0, -1).toLowerCase();
  return (
    <div className="page">
      <PageHeader title={title} description={description}>
        <button className="btn primary" onClick={onAdd}>
          <Icon name="plus" /> Add {singular}
        </button>
      </PageHeader>
      {items.length ? (
        <div className="generic-card-grid">
          {items.map((item) => (
            <article className="surface generic-card" key={item.id}>
              {render(item)}
              <footer>
                <button
                  className="btn secondary compact"
                  onClick={() => onEdit(item)}
                >
                  <Icon name="edit" /> Edit
                </button>
                <button
                  className="btn ghost compact danger-link"
                  onClick={() =>
                    confirm("Delete this record?") && onDelete(item.id)
                  }
                >
                  <Icon name="trash" /> Delete
                </button>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          icon={icon}
          title={`No ${title.toLowerCase()}`}
          text={`Create your first ${singular}.`}
          action={
            <button className="btn primary compact" onClick={onAdd}>
              Add {singular}
            </button>
          }
        />
      )}
      {modal}
    </div>
  );
}

function AppInner() {
  const { user, setUser } = useApp();
  const location = useLocation();
  const [checking, setChecking] = useState(Boolean(getToken()));
  const isPortal = location.pathname === "/portal/access";

  const getInitialUnauthView = (): "home" | "pricing" | "demo" | "login" => {
    const hash = window.location.hash.toLowerCase();
    if (hash.includes("pricing")) return "pricing";
    if (hash.includes("demo") || hash.includes("lab")) return "demo";
    if (
      hash.includes("login") ||
      hash.includes("signin") ||
      hash.includes("setup")
    )
      return "login";
    return "home";
  };

  const [unauthView, setUnauthView] = useState<
    "home" | "pricing" | "demo" | "login"
  >(getInitialUnauthView);

  useEffect(() => {
    const onHashChange = () => {
      setUnauthView(getInitialUnauthView());
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigateToHome = () => {
    window.location.hash = "#/home";
    setUnauthView("home");
    window.scrollTo(0, 0);
  };
  const navigateToPricing = () => {
    window.location.hash = "#/pricing";
    setUnauthView("pricing");
    window.scrollTo(0, 0);
  };
  const navigateToDemo = () => {
    window.location.hash = "#/demo";
    setUnauthView("demo");
    window.scrollTo(0, 0);
  };
  const navigateToLogin = () => {
    window.location.hash = "#/login";
    setUnauthView("login");
    window.scrollTo(0, 0);
  };

  useEffect(() => {
    if (isPortal || !getToken()) {
      setChecking(false);
      return;
    }
    api<{ user: any }>("/auth/me")
      .then((result) => setUser(result.user))
      .catch(() => setToken(""))
      .finally(() => setChecking(false));
  }, []);

  if (isPortal) return <PortalView />;
  if (checking)
    return (
      <main className="min-h-screen bg-[#f7f7f7] dark:bg-[#090d13] flex items-center justify-center p-4 tunaxa-grid-texture font-mono">
        <div className="border border-[#d1d1d1] dark:border-[#21262d] bg-white dark:bg-[#161b22] p-8 text-center relative shadow-sm max-w-sm w-full">
          <CornerBrackets stroke="#3b82f6" size={8} />
          <PixelIndicator active pulseColor="blue" className="mx-auto mb-3" />
          <div className="text-xs text-[#71717a] dark:text-[#8b949e]">
            LOADING TUNAXA AXA CRM…
          </div>
        </div>
      </main>
    );
  if (user)
    return (
      <OnboardingGate userId={user.id}>
        <Suspense fallback={<div className="table-loading">Loading…</div>}>
          <AppRoutes />
        </Suspense>
      </OnboardingGate>
    );

  if (unauthView === "pricing") {
    return (
      <PricingPage
        onNavigateToHome={navigateToHome}
        onNavigateToLogin={navigateToLogin}
        onNavigateToDemo={navigateToDemo}
        onNavigateToSetup={navigateToLogin}
      />
    );
  }

  if (unauthView === "login") {
    return (
      <AuthScreen
        onNavigateToHome={navigateToHome}
        onNavigateToPricing={navigateToPricing}
        onNavigateToDemo={navigateToDemo}
      />
    );
  }

  return (
    <HomePage
      onNavigateToLogin={navigateToLogin}
      onNavigateToPricing={navigateToPricing}
      onNavigateToDemo={navigateToDemo}
      onNavigateToSetup={navigateToLogin}
    />
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppInner />
    </AppProvider>
  );
}


