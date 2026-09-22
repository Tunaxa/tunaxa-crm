import {
  useEffect,
  useRef,
  useState,
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
} from "./components/ui";
import { AppProvider, useApp } from "./context/AppContext";
import { api, getToken, json, setToken } from "./lib/api";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useResource } from "./lib/useResource";
import i18n from "./i18n";

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

function AuthScreen() {
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
      setUser(result.user);
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (needsSetup === null)
    return (
      <main className="login-page">
        <section className="login-form-panel">
          <div className="login-card">
            <div className="loading-line" />
          </div>
        </section>
      </main>
    );

  return (
    <main className="login-page">
      <img className="login-bg" src="/crm-dashboard-bg.jpg" alt="" />
      <div className="login-overlay" />
      <section className="login-hero">
        <div className="login-hero-inner">
          <div className="login-brand">
            <img src={logo} alt="Tunaxa" />
            <b>Tunaxa</b>
          </div>
          <div className="login-hero-text">
            <span className="login-hero-label">CRM WORKSPACE</span>
            <h1>One workspace for every customer relationship.</h1>
            <p>
              Manage sales, communication, tasks and revenue from a focused CRM
              workspace.
            </p>
          </div>
          <div className="login-hero-badges">
            <span>
              <Icon name="checkCircle" /> Clean workspace
            </span>
            <span>
              <Icon name="shield" /> Secure access
            </span>
            <span>
              <Icon name="workflow" /> Persistent data
            </span>
          </div>
        </div>
      </section>
      <section className="login-form-panel">
        <form className="login-card" onSubmit={submit}>
          <div className="login-card-head">
            <div className="login-card-icon">N/V</div>
            <div>
              <h2>
                {mode === "setup"
                  ? "Create your workspace"
                  : "Sign in to Tunaxa"}
              </h2>
              <p>
                {mode === "setup"
                  ? "Create the first owner account"
                  : "Open your CRM workspace"}
              </p>
            </div>
            <button
              className="login-theme-toggle"
              type="button"
              onClick={toggleTheme}
              aria-label={theme ? "Switch to light mode" : "Switch to dark mode"}
              title={theme ? "Light mode" : "Dark mode"}
            >
              <Icon name={theme ? "sun" : "moon"} />
            </button>
          </div>
          <div className="login-card-body">
            {mode === "setup" ? (
              <label className="field">
                <span>Your name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Owner name"
                  autoFocus
                />
              </label>
            ) : null}
            <label className="field">
              <span>Email address</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
                autoFocus={mode === "login"}
              />
            </label>
            <label className="field">
              <span>Password</span>
              <div className="input-with-action">
                <input
                  type={show ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimum 6 characters"
                />
                <button
                  type="button"
                  onClick={() => setShow((value) => !value)}
                >
                  <Icon name="eye" />
                </button>
              </div>
            </label>
            {mode === "login" && (
              <label className="check">
                <input type="checkbox" /> Remember me
              </label>
            )}
            <button className="btn login-submit" type="submit" disabled={busy}>
              {busy
                ? "Please wait…"
                : mode === "setup"
                  ? "Create workspace"
                  : "Sign in"}{" "}
              <Icon name="arrowRight" />
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

function Shell() {
  const { user, logout, toast } = useApp();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(
    localStorage.getItem("tunaxa.sidebar") === "1",
  );
  const [mobile, setMobile] = useState(false);
  const [profile, setProfile] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [theme, setTheme] = useState(
    document.documentElement.classList.contains("dark"),
  );

  useEffect(() => {
    localStorage.setItem("tunaxa.sidebar", collapsed ? "1" : "0");
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

  function toggleTheme() {
    const next = !theme;
    setTheme(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("tunaxa.theme", next ? "dark" : "light");
  }

  function toggleLanguage() {
    const current = i18n.language || "en";
    const next = current === "fr" ? "en" : "fr";
    i18n.changeLanguage(next);
    localStorage.setItem("tunaxa.language", next);
  }

  return (
    <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      <div
        className={`mobile-overlay ${mobile ? "show" : ""}`}
        onClick={() => setMobile(false)}
      />
      <aside className={`sidebar ${mobile ? "mobile-open" : ""}`}>
        <div className="sidebar-logo">
          <button className="brand" onClick={() => navigate("/dashboard")}>
            <img src={logo} alt="Tunaxa" />
            <span>Tunaxa</span>
          </button>
          <button
            className="collapse-btn"
            onClick={() => setCollapsed((value) => !value)}
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
            <span className="workspace-mark">NX</span>
            <div>
              <b>Tunaxa</b>
              <small>Local workspace</small>
            </div>
          </div>
        </div>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-btn mobile-menu"
              onClick={() => setMobile(true)}
            >
              <Icon name="menu" />
            </button>
            <div className="crumb">
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
              <span>Search everything</span>
              <kbd>Ctrl K</kbd>
            </button>
            <button
              className="btn primary compact"
              onClick={() => setQuickOpen(true)}
            >
              <Icon name="plus" /> New
            </button>
            <button className="icon-btn" onClick={toggleTheme}>
              <Icon name={theme ? "sun" : "moon"} />
            </button>
            <button
              className="icon-btn notification-btn"
              onClick={() => toast("No new notifications")}
            >
              <Icon name="bell" />
            </button>
            <div className="profile-wrap">
              <button
                className="profile-trigger"
                onClick={() => setProfile((value) => !value)}
              >
                <Avatar name={user?.name || "NX"} />
                <div>
                  <b>{user?.name}</b>
                  <small>{user?.role}</small>
                </div>
                <Icon name="chevronDown" />
              </button>
              {profile ? (
                <div className="profile-menu">
                  <div className="profile-menu-head">
                    <Avatar name={user?.name || "NX"} size={38} />
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
                    <Icon name={theme ? "sun" : "moon"} />{" "}
                    {theme ? "Light mode" : "Dark mode"}
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
              <Route path="/marketing-emails" element={<MarketingEmailsPage />} />
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
              <Route path="/survey-responses" element={<SurveyResponsesPage />} />
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
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search leads, contacts, deals, tasks..."
          />
          <button className="icon-btn tiny" onClick={onClose}>
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
              text="Nothing in your JSON database matches this search."
            />
          )}
        </div>
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
          <article className="stat-card" key={card[0]}>
            <div className={`stat-icon tone-${card[4]}`}>
              <Icon name={card[3]} />
            </div>
            <div>
              <small>{card[0]}</small>
              <strong>{card[1]}</strong>
              <span>{card[2]}</span>
            </div>
          </article>
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
const leadFields: FieldSpec[] = [
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
const contactFields: FieldSpec[] = [
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
  {
    key: "items",
    label: 'Line items (one per line, e.g. "Product x3 = 150")',
    type: "textarea",
  },
  { key: "discount", label: "Discount", type: "number" },
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
}) {
  const { items, loading, load, create, update, remove } =
    useResource<Row>(resource);
  const { toast } = useApp();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
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
  const rows = items.filter(
    (row) =>
      !query || JSON.stringify(row).toLowerCase().includes(query.toLowerCase()),
  );

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
          onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])}
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
        <button className="btn primary" onClick={() => setEdit(null)}>
          <Icon name="plus" /> Add {singular}
        </button>
      </PageHeader>
      <section className="surface table-surface">
        <div className="table-toolbar">
          <div className="header-search">
            <Icon name="search" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${title.toLowerCase()}`}
            />
          </div>
          <span className="table-count">{items.length} total</span>
        </div>
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

function useSchema(object: string): FieldSpec[] {
  const [custom, setCustom] = useState<FieldSpec[]>([]);
  useEffect(() => {
    api<{ fields: FieldSpec[] }>(`/schema/${object}`)
      .then((schema) => setCustom(schema.fields))
      .catch(() => {});
  }, [object]);
  return custom;
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
  const rows = items.filter(
    (row) =>
      !query || JSON.stringify(row).toLowerCase().includes(query.toLowerCase()),
  );

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
    const keys = allFields.map((x) => x.key);
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
        <button
          className="btn secondary"
          disabled={!items.length}
          onClick={exportCsv}
        >
          <Icon name="download" /> Export
        </button>
        <button className="btn primary" onClick={() => setEdit(null)}>
          <Icon name="plus" /> Add {title.slice(0, -1).toLowerCase()}
        </button>
      </PageHeader>
      <section className="surface table-surface">
        <div className="table-toolbar">
          <div className="header-search">
            <Icon name="search" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${title.toLowerCase()}`}
            />
          </div>
          <span className="table-count">{items.length} total</span>
        </div>
        {loading ? (
          <div className="table-loading">Loading…</div>
        ) : rows.length ? (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Company</th>
                <th>Email</th>
                <th>Phone</th>
                <th>{resource === "leads" ? "Status" : "Owner"}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <button
                      className="person-cell person-link"
                      onClick={() => navigate(`/${resource}/${row.id}`)}
                    >
                      <Avatar name={row.name || "NX"} src={row.avatar} />
                      <div>
                        <b>{row.name || "Untitled"}</b>
                        <small>{row.role || row.source || "—"}</small>
                      </div>
                    </button>
                  </td>
                  <td>{row.company || "—"}</td>
                  <td>{row.email || "—"}</td>
                  <td>{row.phone || "—"}</td>
                  <td>
                    {resource === "leads" ? (
                      <Badge
                        tone={
                          row.status === "Qualified"
                            ? "green"
                            : row.status === "Lost"
                              ? "red"
                              : "blue"
                        }
                      >
                        {row.status || "New"}
                      </Badge>
                    ) : (
                      row.owner || "—"
                    )}
                  </td>
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
                          confirm(`Delete ${row.name || "record"}?`) &&
                          remove(row.id)
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
                : `Add your first ${title.slice(0, -1).toLowerCase()} or import a CSV file.`
            }
            action={
              !query ? (
                <button
                  className="btn primary compact"
                  onClick={() => setEdit(null)}
                >
                  Add {title.slice(0, -1).toLowerCase()}
                </button>
              ) : undefined
            }
          />
        )}
      </section>
      {edit !== undefined ? (
        <RecordForm
          title={`${edit ? "Edit" : "Add"} ${title.slice(0, -1)}`}
          fields={peopleFields}
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

const detailTabList = ["Overview", "Activity", "Notes", "Emails"] as const;
type DetailTab = (typeof detailTabList)[number];

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
  const [messages, setMessages] = useState<Row[]>([]);
  const [noteText, setNoteText] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);

  const recordName = record?.name || record?.title || "Untitled";

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
    if (!record) return;
    const name = record.name || record.title || "";
    api<Row[]>("/activities")
      .then((items) =>
        setActivities(
          items.filter(
            (a) =>
              a.contact === name ||
              a.title?.toLowerCase().includes(name.toLowerCase()),
          ),
        ),
      )
      .catch(() => {});
    if (record.email)
      api<Row[]>("/messages")
        .then((items) =>
          setMessages(items.filter((m) => m.to === record.email)),
        )
        .catch(() => {});
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
            <h1>{recordName}</h1>
            <p>
              {record.company || record.role || record.industry || ""}
              {record.email ? ` · ${record.email}` : ""}
            </p>
          </div>
          <div className="detail-actions">
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
              onClick={deleteRecord}
            >
              <Icon name="trash" />
            </button>
          </div>
        </div>
      </div>

      <div className="detail-tabs">
        {detailTabList.map((t) => (
          <button
            key={t}
            className={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t}
            {t === "Emails" && messages.length ? (
              <span>{messages.length}</span>
            ) : t === "Activity" && activities.length ? (
              <span>{activities.length}</span>
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
            {activities.length ? (
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
            {activities
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
            {!activities.filter((a) => a.type === "Note").length &&
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
      </div>

      {edit ? (
        <RecordForm
          title={`Edit ${title.slice(0, -1)}`}
          fields={detailFields}
          initial={record}
          onClose={() => setEdit(false)}
          onSave={async (data) => {
            try {
              await api(`/${resource}/${record.id}`, json("PATCH", data));
              setRecord((prev) => (prev ? { ...prev, ...data } : prev));
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
  const [form, setForm] = useState<Record<string, any>>(
    Object.fromEntries(
      fields.map((field) => [
        field.key,
        initial[field.key] ??
          (field.type === "select"
            ? field.options?.[0] || ""
            : field.type === "checkbox"
              ? false
              : ""),
      ]),
    ),
  );
  const [busy, setBusy] = useState(false);

  async function save() {
    const missing = fields.find(
      (field) => field.required && !String(form[field.key] ?? "").trim(),
    );
    if (missing) return toast(`${missing.label} is required`, "error");
    setBusy(true);
    try {
      await onSave(form);
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
          <button className="btn primary" disabled={busy} onClick={save}>
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
              name={String(form.name || form.title || "")}
              value={form[field.key]}
              onChange={(url) =>
                setForm((current) => ({ ...current, [field.key]: url }))
              }
            />
          ) : field.type === "checkbox" ? (
            <label className="toggle-row" key={field.key}>
              <input
                type="checkbox"
                checked={Boolean(form[field.key])}
                onChange={(e) =>
                  setForm((current) => ({
                    ...current,
                    [field.key]: e.target.checked,
                  }))
                }
              />
              <span>{field.label}</span>
            </label>
          ) : (
            <label className="field" key={field.key}>
              <span>
                {field.label}
                {field.required ? <em className="required-mark">*</em> : null}
              </span>
              {field.type === "select" ? (
                <select
                  value={form[field.key]}
                  onChange={(e) =>
                    setForm((current) => ({
                      ...current,
                      [field.key]: e.target.value,
                    }))
                  }
                >
                  {field.options?.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : field.type === "textarea" ? (
                <textarea
                  value={form[field.key]}
                  onChange={(e) =>
                    setForm((current) => ({
                      ...current,
                      [field.key]: e.target.value,
                    }))
                  }
                  placeholder={field.placeholder}
                  rows={6}
                />
              ) : (
                <input
                  type={field.type || "text"}
                  required={field.required}
                  value={form[field.key]}
                  placeholder={field.placeholder}
                  onChange={(e) =>
                    setForm((current) => ({
                      ...current,
                      [field.key]:
                        field.type === "number"
                          ? Number(e.target.value)
                          : e.target.value,
                    }))
                  }
                />
              )}
            </label>
          ),
        )}
      </div>
    </Drawer>
  );
}

function CompaniesPage() {
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
  return (
    <div className="page">
      <PageHeader
        title="Companies"
        description="Accounts, organizations and relationship ownership."
      >
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
                    onClick={() => setEdit(company)}
                  >
                    <Icon name="edit" />
                  </button>
                  <button
                    className="icon-btn tiny danger-link"
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

function PipelinePage() {
  const { items, create, update, remove } = useResource<Row>("deals");
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
                            onClick={() => setEdit(row)}
                          >
                            <Icon name="edit" />
                          </button>
                          <button
                            className="icon-btn tiny danger-link"
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
                          onClick={() => setEdit(task)}
                        >
                          <Icon name="edit" />
                        </button>
                        <button
                          className="icon-btn tiny danger-link"
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
            onClick={() =>
              setCursor((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))
            }
          >
            <Icon name="arrowLeft" />
          </button>
          <h2>{monthLabel}</h2>
          <button
            className="icon-btn"
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
  const { items, create, update, remove } = useResource<Row>("workflows");
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);
  const [meta, setMeta] = useState<WorkflowMeta>({ events: [], actions: [] });
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
        <button
          className="btn primary"
          disabled={!meta.events.length}
          onClick={() => setEdit(null)}
        >
          <Icon name="plus" /> New workflow
        </button>
      </PageHeader>
      {items.length ? (
        <div className="workflow-list">
          {items.map((flow) => (
            <article className="surface workflow-card" key={flow.id}>
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
                        ? meta.events.find((e) => e.value === flow.event)
                            ?.label || flow.event
                        : "Legacy (text)"}
                    </span>
                    <span className="workflow-arrow">
                      <Icon name="arrowRight" />
                    </span>
                    <span className="workflow-action-note">
                      {flow.actions?.length
                        ? `${flow.actions.length} action${flow.actions.length > 1 ? "s" : ""}`
                        : "No actions"}
                    </span>
                    {flow.filter?.field ? (
                      <span className="workflow-filter">
                        when {flow.filter.field} = {flow.filter.value}
                      </span>
                    ) : null}
                  </p>
                </div>
                <div className="flow-actions">
                  <Toggle
                    value={Boolean(flow.enabled)}
                    onChange={(enabled) => update(flow.id, { enabled })}
                  />
                  <button
                    className="icon-btn tiny"
                    onClick={() => setEdit(flow)}
                  >
                    <Icon name="edit" />
                  </button>
                  <button
                    className="icon-btn tiny danger-link"
                    onClick={() =>
                      confirm("Delete this workflow?") && remove(flow.id)
                    }
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
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
      {edit !== undefined ? (
        <WorkflowForm
          meta={meta}
          initial={edit || {}}
          onClose={() => setEdit(undefined)}
          onSave={async (data) => {
            edit?.id
              ? await update(edit.id, data)
              : await create({ ...data, enabled: true });
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
    try {
      const result = await api<Row>(
        `/recordings/${item.id}/transcribe`,
        json("POST"),
      );
      setSelected(result);
      toast("Transcription ready");
      load();
    } catch (error) {
      toast((error as Error).message, "error");
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
                disabled={!selected.fileUrl}
                onClick={() => transcribe(selected)}
              >
                <Icon name="ai" /> Transcribe
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
            <p className="transcript-text">
              {selected.transcript || "No transcript is available yet."}
            </p>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function InboxPage() {
  const { items, update, remove, load } = useResource<Row>("messages");
  const { toast } = useApp();
  const [compose, setCompose] = useState(false);
  const [selected, setSelected] = useState<Row | null>(null);
  const [sending, setSending] = useState(false);
  const [templates, setTemplates] = useState<Row[]>([]);
  const [templateId, setTemplateId] = useState("");

  useEffect(() => {
    api<Row[]>("/templates")
      .then(setTemplates)
      .catch(() => {});
  }, []);

  function applyTemplate(id: string) {
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setSelected((prev) =>
      prev
        ? {
            ...prev,
            subject: t.subject,
            body: t.body,
            channel: t.channel || "Email",
          }
        : prev,
    );
  }

  async function send(message: Row) {
    setSending(true);
    try {
      const saved = await api<Row>(
        "/messages/send",
        json("POST", {
          id: message.id,
          channel: message.channel,
          to: message.to,
          subject: message.subject,
          body: message.body,
          contact: message.contact,
        }),
      );
      setSelected(saved);
      await load();
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

  const statusTone = (status?: string) =>
    status === "Sent"
      ? "green"
      : status === "Failed"
        ? "red"
        : status === "Saved"
          ? "amber"
          : "blue";
  return (
    <div className="page">
      <PageHeader
        title="Email & SMS"
        description="Manage email and SMS conversations from one place."
      >
        <button className="btn primary" onClick={() => setCompose(true)}>
          <Icon name="send" /> Compose
        </button>
      </PageHeader>
      <section className="surface inbox-shell">
        {items.length ? (
          <div className="inbox-list">
            {items.map((message) => (
              <button
                key={message.id}
                className={selected?.id === message.id ? "active" : ""}
                onClick={() => {
                  setSelected(message);
                  update(message.id, { read: true });
                }}
              >
                <span
                  className={`message-channel ${message.channel === "SMS" ? "sms" : ""}`}
                >
                  <Icon name={message.channel === "SMS" ? "message" : "mail"} />
                </span>
                <div>
                  <b>{message.to || "Unknown recipient"}</b>
                  <small>
                    {message.subject ||
                      message.body?.slice(0, 60) ||
                      "No content"}
                  </small>
                  <div className="message-meta-row">
                    <Badge tone={statusTone(message.status)}>
                      {message.status || "Saved"}
                    </Badge>
                    {message.openedAt ? (
                      <span
                        className="tracking-indicator"
                        title={`Opened ${message.openCount || 1} time${(message.openCount || 1) > 1 ? "s" : ""}`}
                      >
                        <Icon name="eye" /> {message.openCount || 1}
                      </span>
                    ) : null}
                    {message.clickedAt ? (
                      <span
                        className="tracking-indicator clicked"
                        title={`Clicked ${message.clickCount || 1} time${(message.clickCount || 1) > 1 ? "s" : ""}`}
                      >
                        <Icon name="arrowRight" /> {message.clickCount || 1}
                      </span>
                    ) : null}
                  </div>
                </div>
                <time>{new Date(message.createdAt).toLocaleDateString()}</time>
              </button>
            ))}
          </div>
        ) : (
          <Empty
            icon="inbox"
            title="No messages"
            text="Compose your first email or SMS. Messages saved here are ready for provider delivery when an integration is configured."
            action={
              <button
                className="btn primary compact"
                onClick={() => setCompose(true)}
              >
                Compose
              </button>
            }
          />
        )}
        {selected ? (
          <div className="message-pane">
            <header>
              <div>
                <b>{selected.subject || `${selected.channel} message`}</b>
                <small>
                  To {selected.to} ·{" "}
                  <Badge tone={statusTone(selected.status)}>
                    {selected.status || "Saved"}
                  </Badge>
                  {selected.error ? ` · ${selected.error}` : ""}
                  {selected.openedAt ? (
                    <span
                      className="tracking-badge"
                      title={`Opened ${new Date(selected.openedAt).toLocaleString()} (${selected.openCount || 1}×)`}
                    >
                      {" "}
                      · Opened {selected.openCount || 1}×
                    </span>
                  ) : null}
                  {selected.clickedAt ? (
                    <span
                      className="tracking-badge clicked"
                      title={`Clicked ${new Date(selected.clickedAt).toLocaleString()} (${selected.clickCount || 1}×)`}
                    >
                      {" "}
                      · Clicked {selected.clickCount || 1}×
                    </span>
                  ) : null}
                </small>
              </div>
              <div className="row-actions">
                <button
                  className="btn primary compact"
                  disabled={sending}
                  onClick={() => send(selected)}
                >
                  <Icon name="send" /> {sending ? "Sending…" : "Send"}
                </button>
                <button
                  className="icon-btn danger-link"
                  onClick={() => {
                    confirm("Delete this message?") && remove(selected.id);
                    setSelected(null);
                  }}
                >
                  <Icon name="trash" />
                </button>
              </div>
            </header>
            <div className="message-thread">
              <article
                className={
                  selected.channel === "SMS"
                    ? "sms-bubble sent"
                    : "email-message"
                }
              >
                <p>{selected.body}</p>
              </article>
            </div>
          </div>
        ) : (
          <div className="message-empty">
            <Empty
              icon="inbox"
              title="Select a message"
              text="Choose a conversation from the list or compose a new message."
            />
          </div>
        )}
      </section>
      {compose ? (
        <Drawer
          title="New message"
          subtitle="Compose an email or SMS."
          onClose={() => {
            setCompose(false);
            setTemplateId("");
          }}
          footer={
            <>
              <button
                className="btn secondary"
                onClick={() => {
                  setCompose(false);
                  setTemplateId("");
                }}
              >
                Cancel
              </button>
            </>
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
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="field">
              <span>Channel</span>
              <select
                value={selected?.channel || "Email"}
                onChange={(e) =>
                  setSelected((prev) =>
                    prev
                      ? { ...prev, channel: e.target.value }
                      : {
                          channel: e.target.value,
                          to: "",
                          subject: "",
                          body: "",
                          id: "",
                        },
                  )
                }
              >
                <option value="Email">Email</option>
                <option value="SMS">SMS</option>
              </select>
            </label>
            <label className="field">
              <span>Recipient *</span>
              <input
                type="email"
                value={selected?.to || ""}
                onChange={(e) =>
                  setSelected((prev) =>
                    prev
                      ? { ...prev, to: e.target.value }
                      : {
                          channel: "Email",
                          to: e.target.value,
                          subject: "",
                          body: "",
                          id: "",
                        },
                  )
                }
                placeholder="recipient@example.com"
              />
            </label>
            {selected?.channel !== "SMS" ? (
              <label className="field">
                <span>Subject</span>
                <input
                  type="text"
                  value={selected?.subject || ""}
                  onChange={(e) =>
                    setSelected((prev) =>
                      prev
                        ? { ...prev, subject: e.target.value }
                        : {
                            channel: "Email",
                            to: "",
                            subject: e.target.value,
                            body: "",
                            id: "",
                          },
                    )
                  }
                  placeholder="Email subject"
                />
              </label>
            ) : null}
            <label className="field">
              <span>Message *</span>
              <textarea
                value={selected?.body || ""}
                onChange={(e) =>
                  setSelected((prev) =>
                    prev
                      ? { ...prev, body: e.target.value }
                      : {
                          channel: "Email",
                          to: "",
                          subject: "",
                          body: e.target.value,
                          id: "",
                        },
                  )
                }
                placeholder="Write your message…"
                rows={8}
              />
            </label>
            <button
              className="btn primary"
              disabled={!selected?.to || !selected?.body || sending}
              onClick={async () => {
                if (!selected?.to || !selected?.body) return;
                setSending(true);
                try {
                  const saved = await api<Row>(
                    "/messages/send",
                    json("POST", {
                      id: selected.id,
                      channel: selected.channel || "Email",
                      to: selected.to,
                      subject: selected.subject,
                      body: selected.body,
                      contact: selected.contact,
                    }),
                  );
                  await load();
                  setCompose(false);
                  setSelected(saved);
                  setTemplateId("");
                  toast(
                    saved.deliveredAt
                      ? "Message sent"
                      : saved.status === "Failed"
                        ? "Delivery failed"
                        : "Saved for later",
                  );
                } catch (error) {
                  toast((error as Error).message, "error");
                } finally {
                  setSending(false);
                }
              }}
            >
              {sending ? "Sending…" : "Send"}
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
      nameKey="number"
      statusField="status"
      synopsis={(r) => r.customer || r.deal || ""}
      moneyColumn={["total", "discount"]}
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
  return (
    <CrudTablePage
      resource="goals"
      title="Goals"
      description="Time-bound targets and progress across teams."
      icon="goal"
      fields={goalFields}
      nameKey="name"
      statusField="period"
      synopsis={(r) => `${r.metric || ""}${r.owner ? " · " + r.owner : ""}`}
    />
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
  const load = () =>
    api<any>(`/duplicates?resource=${scope}`)
      .then(setData)
      .catch((err) => toast(err.message, "error"));
  useEffect(() => {
    load();
    window.addEventListener("tunaxa:resource-changed", load);
    return () => window.removeEventListener("tunaxa:resource-changed", load);
  }, [scope]);
  async function mergeGroup(group: any) {
    setBusy(true);
    try {
      await api(
        `/duplicates/merge`,
        json("POST", {
          resource: scope,
          keepId: group.ids[0],
          mergeIds: group.ids.slice(1),
        }),
      );
      toast("Duplicates merged");
      load();
      window.dispatchEvent(new Event("tunaxa:resource-changed"));
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  const groups = data?.duplicates || [];
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
      <section className="surface table-surface">
        {groups.length ? (
          groups.map((group: any, idx: number) => (
            <div className="dupe-group" key={idx}>
              <div className="dupe-group-head">
                <div className="dupe-member">
                  <Avatar name={group.names[0]} />
                  <div>
                    <b>{group.names[0]}</b>
                    <small>Primary record (kept)</small>
                  </div>
                </div>
                <div className="row-actions">
                  <button
                    className="btn secondary compact"
                    disabled={busy}
                    onClick={() => mergeGroup(group)}
                  >
                    <Icon name="check" /> Merge into primary
                  </button>
                </div>
              </div>
              {group.names.slice(1).map((name: string, j: number) => {
                const sc = group.matches?.[j]?.score ?? null;
                return (
                  <div className="dupe-member" key={j}>
                    <Avatar name={name} />
                    <div>
                      <b>{name}</b>
                      <small>Duplicate (will be merged)</small>
                    </div>
                    <div className="row-actions">
                      <Badge
                        tone={
                          sc == null
                            ? "neutral"
                            : sc >= 0.8
                              ? "green"
                              : sc >= 0.6
                                ? "amber"
                                : "red"
                        }
                      >
                        {sc == null
                          ? "n/a"
                          : `${Math.round(sc * 100)}% match to primary`}
                      </Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          ))
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
          <article className="stat-card" key={card[0]}>
            <div className={`stat-icon tone-${card[4]}`}>
              <Icon name={card[3]} />
            </div>
            <div>
              <small>{card[0]}</small>
              <strong>{card[1]}</strong>
              <span>{card[2]}</span>
            </div>
          </article>
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
  const max = Math.max(
    1,
    ...(finance?.monthly || []).flatMap((m: any) => [m.revenue, m.expenses]),
  );
  return (
    <div className="page">
      <PageHeader
        title="Revenue Forecast"
        description="Projected revenue based on recent cash flow."
      />
      <section className="surface report-table">
        <div className="section-head">
          <div>
            <h2>Monthly cash flow</h2>
            <p>Revenue vs expenses</p>
          </div>
          <b className="section-kpi">
            {money(finance?.avgMonthlyRevenue || 0)} <small>avg / month</small>
          </b>
        </div>
        {(finance?.monthly || []).map((m: any) =>
          m.revenue + m.expenses > 0 ? (
            <div className="report-row" key={m.month}>
              <span>{m.label}</span>
              <div className="bar-track dual">
                <i
                  className="rev"
                  style={{ width: `${Math.max(2, (m.revenue / max) * 100)}%` }}
                />
                <i
                  className="exp"
                  style={{ width: `${Math.max(2, (m.expenses / max) * 100)}%` }}
                />
              </div>
              <b>{money(m.profit)}</b>
              <strong>{money(m.revenue)}</strong>
            </div>
          ) : null,
        )}
        {!finance?.monthly?.length ||
        finance.monthly.every((m: any) => m.revenue + m.expenses === 0) ? (
          <Empty
            icon="trend"
            title="No finance data"
            text="Add paid invoices and expenses to see cash flow and forecast."
            action={
              <button
                className="btn primary compact"
                onClick={() => navigate("/invoices")}
              >
                Add invoice
              </button>
            }
          />
        ) : null}
      </section>
      <section className="surface report-table">
        <div className="section-head">
          <div>
            <h2>Next 3 months (projected)</h2>
            <p>Based on rolling average revenue</p>
          </div>
        </div>
        {(finance?.forecast || []).map((f: any) => (
          <div className="report-row" key={f.month}>
            <span>{f.label}</span>
            <div className="bar-track">
              <i
                style={{
                  width: `${Math.min(100, (f.projected / Math.max(1, finance?.avgMonthlyRevenue || 1) / 4) * 100)}%`,
                }}
              />
            </div>
            <b>projected</b>
            <strong>{money(f.projected)}</strong>
          </div>
        ))}
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
      <div className="stats-grid">
        <article className="stat-card">
          <div className="stat-icon tone-blue">
            <Icon name="lead" />
          </div>
          <div>
            <small>Total leads</small>
            <strong>{leads.items.length}</strong>
            <span>All lead records</span>
          </div>
        </article>
        <article className="stat-card">
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
        </article>
        <article className="stat-card">
          <div className="stat-icon tone-purple">
            <Icon name="phone" />
          </div>
          <div>
            <small>Calls logged</small>
            <strong>{calls.items.length}</strong>
            <span>Inbound and outbound</span>
          </div>
        </article>
        <article className="stat-card">
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
        </article>
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
  const { items, create, update, remove } = useResource<Row>("team");
  const [edit, setEdit] = useState<Row | null | undefined>(undefined);
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
  return (
    <div className="page">
      <PageHeader
        title="Team & Roles"
        description="Workspace members and role assignments."
      >
        <button className="btn primary" onClick={() => setEdit(null)}>
          <Icon name="plus" /> Add member
        </button>
      </PageHeader>
      <section className="surface table-surface">
        {items.length ? (
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
                        onClick={() => setEdit(member)}
                      >
                        <Icon name="edit" />
                      </button>
                      {member.role !== "Owner" ? (
                        <button
                          className="icon-btn tiny danger-link"
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
                onClick={() => setEdit(null)}
              >
                Add member
              </button>
            }
          />
        )}
      </section>
      {edit !== undefined ? (
        <RecordForm
          title={`${edit ? "Edit" : "Add"} team member`}
          fields={[avatarField, ...fieldsForForm]}
          initial={edit || { status: "Invited", role: "Sales rep" }}
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
                      value={Boolean(item.required)}
                      onChange={(required) => update(item.id, { required })}
                    />
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="icon-btn tiny"
                        onClick={() => setEdit(item)}
                      >
                        <Icon name="edit" />
                      </button>
                      <button
                        className="icon-btn tiny danger-link"
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
                <button className="icon-btn tiny" onClick={() => setEdit(t)}>
                  <Icon name="edit" />
                </button>
                <button
                  className="icon-btn tiny danger-link"
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
  useEffect(() => {
    api<Record<string, any>>("/settings")
      .then(setSettings)
      .catch((error) => toast(error.message, "error"));
  }, []);
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
  async function save() {
    try {
      const saved = await api<Record<string, any>>(
        "/settings",
        json("PUT", settings),
      );
      setSettings(saved);
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
        value={settings[key] || ""}
        placeholder={options?.placeholder}
        onChange={(e) => set(key, e.target.value)}
      />
    </label>
  );

  return (
    <div className="page">
      <PageHeader
        title="Settings"
        description="Manage your workspace preferences and integrations."
      >
        <button className="btn primary" onClick={save}>
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
                    <select
                      value={settings.currency || "USD"}
                      onChange={(e) => set("currency", e.target.value)}
                    >
                      <option>USD</option>
                      <option>EUR</option>
                      <option>TND</option>
                    </select>
                  </label>
                  {input("timezone", "Timezone")}
                  <label className="field">
                    <span>Week starts</span>
                    <select
                      value={settings.weekStarts || "Monday"}
                      onChange={(e) => set("weekStarts", e.target.value)}
                    >
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
                  value={settings.callRecording}
                  onChange={(v) => set("callRecording", v)}
                />
                <Setting
                  title="Local presence"
                  text="Use a matching local outbound number when your provider supports it."
                  value={settings.localPresence}
                  onChange={(v) => set("localPresence", v)}
                />
                <Setting
                  title="Voicemail detection"
                  text="Enable voicemail detection for a connected provider."
                  value={settings.voicemailDetection}
                  onChange={(v) => set("voicemailDetection", v)}
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
                  value={settings.emailTracking}
                  onChange={(v) => set("emailTracking", v)}
                />
                <Setting
                  title="Two-way SMS"
                  text="Allow replies through a connected SMS provider."
                  value={settings.twoWaySms}
                  onChange={(v) => set("twoWaySms", v)}
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
                      value={String(settings.smtpSecure)}
                      onChange={(e) =>
                        set("smtpSecure", e.target.value === "true")
                      }
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
                  value={settings.aiTranscription}
                  onChange={(v) => set("aiTranscription", v)}
                />
                <Setting
                  title="Automatic summaries"
                  text="Generate call summaries with AI after transcription."
                  value={settings.aiSummaries}
                  onChange={(v) => set("aiSummaries", v)}
                />
                <Setting
                  title="Auto-transcribe Twilio recordings"
                  text="Transcribe incoming call recordings automatically."
                  value={settings.autoTranscribeRecordings}
                  onChange={(v) => set("autoTranscribeRecordings", v)}
                />
                <Setting
                  title="Deal risk"
                  text="Enable deal-risk analysis."
                  value={settings.dealRisk}
                  onChange={(v) => set("dealRisk", v)}
                />
                <Setting
                  title="Real-time coaching"
                  text="Enable live coaching integrations."
                  value={settings.realTimeCoaching}
                  onChange={(v) => set("realTimeCoaching", v)}
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
      <Toggle value={Boolean(value)} onChange={onChange} />
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
  const publicBase = "http://127.0.0.1:3001";
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
          <Toggle value={enabled} onChange={setEnabled} />
        </div>
        <div className="setting-toggle">
          <div>
            <b>Progressive profiling</b>
            <p>Hide fields the visitor has already answered.</p>
          </div>
          <Toggle value={progressive} onChange={setProgressive} />
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
          <Toggle value={enabled} onChange={setEnabled} />
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
      <main className="login-page">
        <section className="login-form-panel">
          <div className="login-card">Loading Tunaxa…</div>
        </section>
      </main>
    );
  return user ? <Shell /> : <AuthScreen />;
}

export default function App() {
  return (
    <AppProvider>
      <AppInner />
    </AppProvider>
  );
}
