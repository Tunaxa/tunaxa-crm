import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeadsPage } from "./sales/LeadsPage";
import { ContactsPage } from "./sales/ContactsPage";
import { CompaniesPage } from "./sales/CompaniesPage";
import { PipelinePage } from "./sales/PipelinePage";
import { CampaignsPage } from "./marketing/CampaignsPage";
import { EmailListsPage } from "./marketing/EmailListsPage";
import { MarketingEmailsPage } from "./marketing/MarketingEmailsPage";
import { FormsPage } from "./marketing/FormsPage";
import { RecordForm } from "../components/records/RecordForm";
import { leadFields } from "./sales/fields";

const mocks = vi.hoisted(() => ({ resource: vi.fn(), navigate: vi.fn(), role: "member" }));
vi.mock("../lib/useResource", () => ({ useResource: mocks.resource }));
vi.mock("../components/records/useSchema", () => ({ useSchema: () => [] }));
vi.mock("../context/AppContext", () => ({ useApp: () => ({ user: { role: mocks.role }, toast: vi.fn() }) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => ({ "nav.leads": "Prospects", "nav.contacts": "Contacts" })[key] || key }) }));

const resourceState = (patch = {}) => ({
  items: [], loading: false, error: "", total: 0, page: 1, limit: 25,
  load: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), ...patch,
});
const pages = [
  { component: LeadsPage, resource: "leads", title: "Prospects" },
  { component: ContactsPage, resource: "contacts", title: "Contacts" },
  { component: CompaniesPage, resource: "companies", title: "Companies" },
  { component: PipelinePage, resource: "deals", title: "Pipeline" },
  { component: CampaignsPage, resource: "campaigns", title: "Campaigns" },
  { component: EmailListsPage, resource: "emailLists", title: "Email Lists" },
  { component: MarketingEmailsPage, resource: "marketingEmails", title: "Marketing Emails" },
  { component: FormsPage, resource: "forms", title: "Forms" },
];

beforeEach(() => {
  mocks.resource.mockReset().mockReturnValue(resourceState());
  mocks.role = "member";
  vi.stubGlobal("localStorage", { getItem: () => "25" });
  vi.stubGlobal("window", { location: { origin: "https://crm.example.test" } });
});
afterEach(() => vi.unstubAllGlobals());

describe("Sales and Marketing module parity", () => {
  it.each(pages)("$resource retains its resource and page title", ({ component: Page, resource, title }) => {
    const html = renderToStaticMarkup(<Page />);
    expect(html).toContain(title);
    expect(mocks.resource.mock.calls[0][0]).toBe(resource);
  });
  it.each(pages)("$resource shows loading before an empty state", ({ component: Page }) => {
    mocks.resource.mockReturnValue(resourceState({ loading: true }));
    const html = renderToStaticMarkup(<Page />);
    expect(html).toContain("Loading");
    expect(html).not.toContain("No deals");
    expect(html).not.toContain("No companies");
    expect(html).not.toContain("No forms");
  });
  it.each(pages)("$resource exposes a request failure and retry", ({ component: Page }) => {
    mocks.resource.mockReturnValue(resourceState({ error: "Request failed" }));
    const html = renderToStaticMarkup(<Page />);
    expect(html).toContain("Request failed");
    expect(html).toContain("Retry");
    expect(html).not.toContain("No deals");
    expect(html).not.toContain("No companies");
    expect(html).not.toContain("No forms");
    expect(html).not.toContain("yet</h3>");
  });
  it("keeps lead nurture status, custom properties, CSV controls and bulk selection", () => {
    mocks.resource.mockReturnValue(resourceState({ items: [{ id: "lead-1", name: "Alex", status: "Nurture" }], total: 1 }));
    const html = renderToStaticMarkup(<LeadsPage />);
    expect(html).toContain("Nurture");
    expect(html).toContain("Import");
    expect(html).toContain("Export CSV");
    expect(html).toContain('aria-label="Select Alex"');
    expect(html).toContain("Advanced filters");
    expect(leadFields.find(field => field.key === "status")?.options).toContain("Nurture");
  });
  it("keeps row selection hidden for viewers", () => {
    mocks.role = "viewer";
    mocks.resource.mockReturnValue(resourceState({ items: [{ id: "contact-1", name: "Alex" }], total: 1 }));
    expect(renderToStaticMarkup(<ContactsPage />)).not.toContain('aria-label="Select Alex"');
  });
  it("renders campaign counts without treating them as currency", () => {
    mocks.resource.mockReturnValue(resourceState({ items: [{ id: "campaign-1", name: "Launch", target: 400, reached: 200 }], total: 1 }));
    const html = renderToStaticMarkup(<CampaignsPage />);
    expect(html).toContain("400");
    expect(html).not.toContain("$400");
  });
  it("loads full deal and marketing lists before applying local pagination", () => {
    renderToStaticMarkup(<PipelinePage />);
    expect(mocks.resource).toHaveBeenCalledWith("deals", { all: true });
    renderToStaticMarkup(<CampaignsPage />);
    expect(mocks.resource).toHaveBeenCalledWith("campaigns", { all: true });
  });
  it("keeps form status, submissions, public URL action and server pagination", () => {
    mocks.resource.mockReturnValue(resourceState({ items: [{ id: "form-1", title: "Contact us", permalink: "contact-us", enabled: true, submissionCount: 7 }], total: 30 }));
    const html = renderToStaticMarkup(<FormsPage />);
    expect(html).toContain("Contact us");
    expect(html).toContain("Enabled");
    expect(html).toContain("7 submissions");
    expect(html).toContain("Copy URL");
    expect(html).toContain("Page 1 of 2");
    expect(mocks.resource).toHaveBeenCalledWith("forms", { page: 1, limit: 25 });
  });
  it("uses the shared form for schema fields and typed inputs", () => {
    const html = renderToStaticMarkup(<RecordForm title="Edit record" initial={{}} onClose={() => {}} onSave={async () => {}}
      fields={[{ key: "priority", label: "Custom priority", type: "select", options: ["Low", "High"] }, { key: "value", label: "Value", type: "number" }]} />);
    expect(html).toContain("Custom priority");
    expect(html).toContain('value="High"');
    expect(html).toContain('type="number"');
  });
});
