import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntegrationsPage } from "./IntegrationsPage";
import { SlackSetup } from "./SlackSetup";

const mocks = vi.hoisted(() => ({
  state: {
    config: null as null | {
      slack: { configured: boolean; webhookUrlMasked: string };
      zapier: { configured: boolean; webhookUrlMasked: string };
    },
    loading: false,
    saving: false,
    testing: false,
    error: "",
    load: vi.fn(),
    saveSlack: vi.fn(),
    disconnectSlack: vi.fn(),
    testSlack: vi.fn(),
  },
  role: "Owner",
}));
vi.mock("./useIntegrations", () => ({ useIntegrations: () => mocks.state }));
vi.mock("../../../context/AppContext", () => ({
  useApp: () => ({ user: { role: mocks.role }, toast: vi.fn() }),
}));

const slack = { configured: true, webhookUrlMasked: "https://hooks.slack.com/••••••123456" };
const empty = { configured: false, webhookUrlMasked: "" };
const page = () => renderToStaticMarkup(<IntegrationsPage />);
const integrationsCss = readFileSync(new URL("./integrations.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const mobileCss = /@media \(max-width: 768px\) \{([\s\S]*?)\n\}/.exec(integrationsCss)?.[1] ?? "";

describe("integration page states", () => {
  beforeEach(() => {
    mocks.state.config = { slack, zapier: empty };
    mocks.state.loading = false;
    mocks.state.saving = false;
    mocks.state.testing = false;
    mocks.state.error = "";
    mocks.role = "Owner";
  });

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
    mocks.state.config!.zapier = {
      configured: true,
      webhookUrlMasked: "https://hooks.zapier.com/••••••123456",
    };
    expect(page()).toContain("Zapier</h2>");
    expect(page()).not.toContain("Connect Zapier");
  });

  it("shows an empty state only for a successfully loaded empty configuration", () => {
    mocks.state.config = { slack: empty, zapier: empty };
    expect(page()).toContain("No connected integrations");
  });

  it("shows the API error without claiming there are no integrations", () => {
    mocks.state.config = null;
    mocks.state.error = "Integrations are unavailable right now.";
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

  it("keeps non administrators read only", () => {
    mocks.role = "member";
    expect(page()).not.toContain("Replace webhook");
  });

  it("shows initial loading without a false empty state", () => {
    mocks.state.config = null;
    mocks.state.loading = true;
    expect(page()).toContain("Loading integrations");
    expect(page()).not.toContain("No connected integrations");
  });
});

describe("Slack setup", () => {
  const setup = (overrides: Partial<ComponentProps<typeof SlackSetup>> = {}) =>
    renderToStaticMarkup(
      <SlackSetup
        current={slack}
        allowed
        available
        saving={false}
        testing={false}
        onClose={vi.fn()}
        onSave={vi.fn(async () => {})}
        onDisconnect={vi.fn(async () => {})}
        onTest={vi.fn(async () => ({ success: true, configured: true, provider: "slack" }))}
        {...overrides}
      />,
    );

  it("uses a blank password input and an explicit accessible label", () => {
    const html = setup();
    expect(html).toContain('type="password"');
    expect(html).toContain('value=""');
    expect(html).not.toContain(`value="${slack.webhookUrlMasked}"`);
    expect(html).toMatch(/aria-labelledby="[^"]+"/);
    expect(html).toContain("Test Connection");
    expect(html).toContain("Disconnect");
    expect(html).toContain("https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks");
  });

  it("locks submission and marks the drawer busy while saving", () => {
    const html = setup({ saving: true });
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/disabled="">Saving…/);
    expect(html).toMatch(/disabled="">Cancel/);
  });

  it("surfaces a status indicator while testing the connection", () => {
    const html = setup({ testing: true });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Testing Slack connection");
  });

  it("prevents setup when the API or role is unavailable", () => {
    const html = setup({ allowed: false, available: false });
    expect(html).toContain("Only workspace administrators");
    expect(html).toContain("Refresh integration configuration before saving");
    expect(html).toMatch(/disabled="">Save Slack configuration/);
  });

  it("keeps all four configured actions inside a wrapping mobile footer", () => {
    const html = setup();
    expect(html).toMatch(/<aside[^>]*class="side-drawer slack-drawer"/);

    const footer = /<footer class="side-drawer-footer">([\s\S]*?)<\/footer>/.exec(html)?.[1] ?? "";
    expect(footer).toContain("Cancel");
    expect(footer).toContain("Test Connection");
    expect(footer).toContain("Disconnect");
    expect(footer).toContain("Save Slack configuration");
    expect(footer.match(/<button\b/g) ?? []).toHaveLength(4);

    expect(integrationsCss).toMatch(/\.side-drawer\.slack-drawer \.side-drawer-footer\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(integrationsCss).toMatch(/html\.dark \.side-drawer\.slack-drawer \.side-drawer-footer\s*\{[^}]*background:\s*var\(--surface\)/);
    expect(mobileCss).toMatch(/\.side-drawer\.slack-drawer\s*\{[^}]*width:\s*100%\s*!important[^}]*max-width:\s*100vw[^}]*box-sizing:\s*border-box/);
    expect(mobileCss).toMatch(/\.side-drawer\.slack-drawer \.side-drawer-footer\s*\{[^}]*flex-direction:\s*column[^}]*align-items:\s*stretch/);
    expect(mobileCss).toMatch(/\.side-drawer\.slack-drawer \.side-drawer-footer \.btn\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*min-height:\s*44px/);
  });
});
