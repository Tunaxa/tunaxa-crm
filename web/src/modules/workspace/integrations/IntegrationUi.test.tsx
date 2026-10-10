import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IntegrationsPage } from "./IntegrationsPage";
import { SlackSetup } from "./SlackSetup";

const mocks = vi.hoisted(() => ({ state: { config: null as null | { slack: { configured: boolean; webhookUrlMasked: string }; zapier: { configured: boolean; webhookUrlMasked: string } }, loading: false, saving: false, error: "", load: vi.fn(), saveSlack: vi.fn() }, role: "Owner" }));
vi.mock("./useIntegrations", () => ({ useIntegrations: () => mocks.state }));
vi.mock("../../../context/AppContext", () => ({ useApp: () => ({ user: { role: mocks.role }, toast: vi.fn() }) }));
const slack = { configured: true, webhookUrlMasked: "https://hooks.slack.com/••••••123456" };
const empty = { configured: false, webhookUrlMasked: "" };
const page = () => renderToStaticMarkup(<IntegrationsPage />);

describe("integration page states", () => {
  beforeEach(() => { mocks.state.config = { slack, zapier: empty }; mocks.state.loading = false; mocks.state.saving = false; mocks.state.error = ""; mocks.role = "Owner"; });
  it("shows configured services and distinguishes configuration from delivery", () => {
    const html = page();
    expect(html).toContain(slack.webhookUrlMasked);
    expect(html).toContain("delivery has not been verified here");
    expect(html).toContain("Replace webhook");
    expect(html).not.toContain("Zapier</h2>");
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tabpanel"');
  });
  it("includes an existing Zapier integration without offering unsupported setup", () => {
    mocks.state.config!.zapier = { configured: true, webhookUrlMasked: "https://hooks.zapier.com/••••••123456" };
    expect(page()).toContain("Zapier</h2>");
    expect(page()).not.toContain("Connect Zapier");
  });
  it("shows an empty state only for a successfully loaded empty configuration", () => {
    mocks.state.config = { slack: empty, zapier: empty };
    expect(page()).toContain("No connected integrations");
  });
  it("shows the API error without claiming there are no integrations", () => {
    mocks.state.config = null; mocks.state.error = "Integrations are not available on this server yet.";
    expect(page()).toContain('role="alert"');
    expect(page()).toContain("Retry integrations");
    expect(page()).not.toContain("No connected integrations");
  });
  it("marks stale configuration and disables writes after a load failure", () => {
    mocks.state.error = "Could not load integration configuration.";
    const html = page();
    expect(html).toContain("Showing the last loaded configuration");
    expect(html).toMatch(/disabled="">Replace webhook/);
  });
  it("keeps non administrators read only", () => { mocks.role = "member"; expect(page()).not.toContain("Replace webhook"); });
  it("shows initial loading without a false empty state", () => {
    mocks.state.config = null; mocks.state.loading = true;
    expect(page()).toContain("Loading integrations");
    expect(page()).not.toContain("No connected integrations");
  });
});

describe("Slack setup", () => {
  it("uses a blank password input rather than pre-filling the masked credential", () => {
    const html = renderToStaticMarkup(<SlackSetup current={slack} allowed available onClose={vi.fn()} onSave={vi.fn()} />);
    expect(html).toContain('type="password"');
    expect(html).toContain('value=""');
    expect(html).not.toContain(`value="${slack.webhookUrlMasked}"`);
    expect(html).toContain("https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks");
    expect(html).toContain("Delivery is not tested by this form");
  });
  it("prevents setup when the API or role is unavailable", () => {
    const html = renderToStaticMarkup(<SlackSetup current={empty} allowed={false} available={false} onClose={vi.fn()} onSave={vi.fn()} />);
    expect(html).toContain("Only workspace administrators");
    expect(html).toContain("Refresh integration configuration before saving");
    expect(html).toMatch(/disabled="">Save Slack configuration/);
  });
});
