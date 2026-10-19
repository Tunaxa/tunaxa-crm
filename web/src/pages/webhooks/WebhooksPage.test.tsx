import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EndpointCard, WebhooksPage } from "./WebhooksPage";
import { parseEndpoint } from "./webhookModel";
const mocks = vi.hoisted(() => ({ role: "member", state: { items: [] as unknown[], loading: false, writing: false, error: "", load: vi.fn(), create: vi.fn(), setActive: vi.fn() } }));
vi.mock("../../context/AppContext", () => ({ useApp: () => ({ user: { id: "u_1", role: mocks.role }, toast: vi.fn() }) }));
vi.mock("./useWebhookEndpoints", () => ({ useWebhookEndpoints: () => mocks.state }));
const endpoint = parseEndpoint({ id: "w_1", url: "https://receiver.example", events: ["contact.created", "deal.won"], is_active: true });
describe("webhook management presentation", () => {
  it("shows URL, events and active status", () => { const html = renderToStaticMarkup(<EndpointCard endpoint={endpoint} editable disabled={false} onStatus={vi.fn()} />); expect(html).toContain(endpoint.url); expect(html).toContain("contact.created"); expect(html).toContain("deal.won"); expect(html).toContain("Active"); expect(html).toContain("Pause endpoint"); });
  it("offers activation for paused subscriptions", () => { expect(renderToStaticMarkup(<EndpointCard endpoint={{ ...endpoint, is_active: false }} editable disabled={false} onStatus={vi.fn()} />)).toContain("Activate endpoint"); });
  it("hides status mutation from viewers", () => { expect(renderToStaticMarkup(<EndpointCard endpoint={endpoint} editable={false} disabled={false} onStatus={vi.fn()} />)).not.toContain("Pause endpoint"); });
  it("does not fabricate delivery history or enable unsupported actions", () => { const html = renderToStaticMarkup(<EndpointCard endpoint={endpoint} editable disabled={false} onStatus={vi.fn()} />); expect(html).toContain("history is not available yet"); expect(html).toMatch(/disabled=""[^>]*>Rotate Secret/); expect(html).toMatch(/disabled=""[^>]*>Resend Failed/); expect(html).not.toContain("No failed deliveries"); });
  it("keeps inbound navigation alongside outgoing management", () => { const html = renderToStaticMarkup(<WebhooksPage inbound={<div>Inbound fixture</div>} />); expect(html).toContain("Outgoing endpoints"); expect(html).toContain("Inbound triggers"); expect(html).toContain("Add endpoint"); });
  it("shows failed loading without claiming an empty list", () => { mocks.state.error = "Could not load"; const html = renderToStaticMarkup(<WebhooksPage inbound={null} />); expect(html).toContain("Retry endpoints"); expect(html).not.toContain("No outgoing endpoints"); mocks.state.error = ""; });
  it("keeps the page read-only for viewers", () => { mocks.role = "viewer"; const html = renderToStaticMarkup(<WebhooksPage inbound={null} />); expect(html).toContain("read-only webhook access"); expect(html).not.toContain("Add endpoint"); mocks.role = "member"; });
});
