import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SequencesPage } from "./SequencesPage";
import { SequenceEditor } from "./SequenceEditor";
import { ContactSequenceEnrollment, EnrollmentPicker } from "./ContactSequenceEnrollment";
import { isModuleVisible, MODULE_CATALOG } from "../../moduleVisibility";
import { contactFields } from "../../sales/fields";
import { RecordDetailPage } from "../../../App";

const mocks = vi.hoisted(() => ({
  resource: vi.fn(),
  api: vi.fn(),
  json: vi.fn((method: string, body?: unknown) => ({ method, body })),
  toast: vi.fn(),
  role: "member",
  params: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("../../../lib/useResource", () => ({ useResource: mocks.resource }));
vi.mock("../../../lib/api", () => ({ api: mocks.api, json: mocks.json }));
vi.mock("../../../context/AppContext", () => ({ useApp: () => ({ user: { role: mocks.role }, toast: mocks.toast }) }));
vi.mock("../../../components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../components/ui")>();
  const { createElement } = await import("react");
  return {
    ...actual,
    Drawer: ({ title, subtitle, children, footer }: { title: string; subtitle?: string; children?: React.ReactNode; footer?: React.ReactNode }) =>
      createElement("section", null,
        createElement("h2", null, title),
        subtitle ? createElement("p", null, subtitle) : null,
        children,
        footer ? createElement("footer", null, footer) : null,
      ),
  };
});
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => mocks.navigate, useParams: () => mocks.params() };
});

const sequence = { id: "seq_a", name: "Three-step outreach", enabled: true, steps: [0, 2, 5].map((delayDays, index) => ({ id: `step_${index}`, subject: `Subject ${index + 1}`, body: `Message ${index + 1}`, delayDays, action: "sendEmail" })) };
const contact = { id: "contact_a", name: "Ada", email: "ada@example.com" };
const enrollment = { id: "enr_a", sequenceId: sequence.id, contactId: contact.id, status: "active", currentStep: 0, nextRunAt: "2026-11-25T20:00:00.000Z" };
const state = (patch: Record<string, unknown> = {}) => ({ items: [sequence], loading: false, error: "", load: vi.fn(), ...patch });
const text = (renderer: ReactTestRenderer, role: "alert" | "status") => renderer.root.findAll(node => typeof node.type === "string" && node.props.role === role).map(node => String(node.props.children ?? "")).join(" ");
const button = (renderer: ReactTestRenderer, label: string) => renderer.root.findAll(node => typeof node.type === "string" && node.type === "button" && node.props.children === label)[0];

beforeEach(() => {
  mocks.role = "member";
  mocks.resource.mockReset().mockReturnValue(state());
  mocks.api.mockReset();
  mocks.json.mockClear();
  mocks.toast.mockReset();
  mocks.params.mockReset().mockReturnValue({ id: contact.id });
  mocks.navigate.mockReset();
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() });
  vi.stubGlobal("CustomEvent", class {
    type: string;
    detail: unknown;
    constructor(type: string, options?: { detail?: unknown }) { this.type = type; this.detail = options?.detail; }
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("Sequence UI", () => {
  it("requests the whole sequence list and displays structured steps", () => {
    const html = renderToStaticMarkup(<SequencesPage />);
    expect(mocks.resource).toHaveBeenCalledWith("sequences", { all: true });
    expect(html).toContain("3 steps");
    expect(html).toContain("Subject 3");
    expect(html).toContain("Wait 5 days");
    expect(html).toContain("Build sequence");
    expect(html).toContain("Edit sequence");
    expect(html).toContain("Disable enrollment");
  });

  it("preserves unsupported legacy text and disables its email editor", () => {
    mocks.resource.mockReturnValue(state({ items: [{ ...sequence, steps: "Legacy description" }] }));
    const html = renderToStaticMarkup(<SequencesPage />);
    expect(html).toContain("Legacy description");
    expect(html).toContain("configuration is preserved");
    expect(html).toContain('disabled="">Edit sequence');
  });

  it.each(["owner", "Owner", "admin", "member"])("lets %s build sequences and enroll contacts", (role) => {
    mocks.role = role;
    expect(renderToStaticMarkup(<SequencesPage />)).toContain("Build sequence");
    expect(renderToStaticMarkup(<ContactSequenceEnrollment contact={contact} />)).toContain("Enroll in sequence");
  });

  it.each(["viewer", "wizard"])("keeps %s strictly read-only", (role) => {
    mocks.role = role;
    const html = renderToStaticMarkup(<SequencesPage />);
    expect(html).not.toContain("Build sequence</button>");
    expect(html).not.toContain("Edit sequence");
    expect(html).not.toContain("Delete sequence");
    expect(renderToStaticMarkup(<ContactSequenceEnrollment contact={contact} />)).toBe("");
  });

  it("registers /sequences as a viewer-visible module for ModuleGate", () => {
    expect(MODULE_CATALOG["/sequences"]).toBe("viewer");
    expect(isModuleVisible("/sequences", null, "viewer")).toBe(true);
    expect(isModuleVisible("/sequences", new Set(["/sequences"]), "viewer")).toBe(true);
    expect(isModuleVisible("/sequences", new Set(["/contacts"]), "viewer")).toBe(false);
  });

  it("shows API failures separately from empty and loading states", () => {
    mocks.resource.mockReturnValue(state({ loading: true }));
    expect(renderToStaticMarkup(<SequencesPage />)).toContain("Loading sequences");
    mocks.resource.mockReturnValue(state({ error: "Request failed" }));
    expect(renderToStaticMarkup(<SequencesPage />)).toContain("Retry");
    mocks.resource.mockReturnValue(state({ items: [] }));
    expect(renderToStaticMarkup(<SequencesPage />)).toContain("No sequences yet");
  });

  it("renders an editor with all three steps, delays, merge hints and keyboard reorder controls", () => {
    const html = renderToStaticMarkup(<SequenceEditor initial={sequence} onClose={() => {}} onSave={async () => {}} />);
    expect(html).toContain("Email 3");
    expect(html).toContain("Message 3");
    expect(html).toContain("Wait Minutes");
    expect(html).toContain("{{firstName}}");
    expect(html).toContain("{{name}}");
    expect(html).toContain("{{email}}");
    expect(html).toContain('aria-label="Move email 1 up" disabled=""');
    expect(html).toContain('aria-label="Move email 2 down"');
  });

  it("reorders and removes email steps through keyboard-accessible buttons", () => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<SequenceEditor initial={sequence} onClose={() => {}} onSave={async () => {}} />); });
    const bodies = () => renderer.root.findAllByType("textarea").map(node => node.props.value);
    expect(bodies()).toEqual(["Message 1", "Message 2", "Message 3"]);
    act(() => button(renderer, "Move Up").props.onClick());
    expect(bodies()).toEqual(["Message 1", "Message 2", "Message 3"]);
    act(() => renderer.root.findByProps({ "aria-label": "Move email 2 up" }).props.onClick());
    expect(bodies()).toEqual(["Message 2", "Message 1", "Message 3"]);
    act(() => renderer.root.findByProps({ "aria-label": "Remove email 3" }).props.onClick());
    expect(bodies()).toEqual(["Message 2", "Message 1"]);
    act(() => renderer.unmount());
  });

  it("shows save failures inline with role=alert", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Save rejected"));
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<SequenceEditor initial={sequence} onClose={() => {}} onSave={onSave} />); });
    await act(async () => { button(renderer, "Save sequence").props.onClick(); });
    expect(text(renderer, "alert")).toContain("Save rejected");
    expect(onSave).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it("announces save progress with role=status", async () => {
    let finish!: () => void;
    const onSave = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<SequenceEditor initial={sequence} onClose={() => {}} onSave={onSave} />); });
    await act(async () => { button(renderer, "Save sequence").props.onClick(); });
    expect(text(renderer, "status")).toContain("Saving sequence");
    await act(async () => { finish(); });
    act(() => renderer.unmount());
  });

  it("offers enrollment from a contact and requires an explicit choice and status check", () => {
    const html = renderToStaticMarkup(<EnrollmentPicker contact={contact} onClose={() => {}} />);
    expect(html).toContain("Ada");
    expect(html).toContain("Three-step outreach");
    expect(html).toContain('disabled="">Enroll contact');
    expect(html).not.toContain("Contact enrolled");
  });

  it("checks the tenant-scoped enrollment path and posts only contactIds", async () => {
    mocks.api.mockImplementation(async (path: string) => {
      if (String(path).includes("/enrollments")) return { data: [], total: 0 };
      if (String(path).endsWith(`/sequences/${sequence.id}`)) return sequence;
      if (String(path).endsWith("/enroll")) return { enrolled: 1, skipped: 0, enrollments: [enrollment] };
      throw new Error(`Unexpected path ${String(path)}`);
    });
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<EnrollmentPicker contact={contact} onClose={() => {}} />); });
    await act(async () => {
      renderer.root.findByType("select").props.onChange({ target: { value: sequence.id } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.api.mock.calls.map(call => call[0])).toContain(`/sequences/${sequence.id}/enrollments?page=1&limit=50`);
    await act(async () => { button(renderer, "Enroll contact").props.onClick(); });
    const call = mocks.api.mock.calls.find(entry => String(entry[0]).endsWith("/enroll"));
    expect(call?.[1]).toEqual({ method: "POST", body: { contactIds: [contact.id] } });
    expect(text(renderer, "status")).toContain("Contact enrolled");
    act(() => renderer.unmount());
  });

  it("prevents duplicate enrollment by disabling the action when active or paused exists", async () => {
    mocks.api.mockImplementation(async (path: string) => {
      if (String(path).includes("/enrollments")) return { data: [enrollment], total: 1 };
      throw new Error(`Unexpected path ${String(path)}`);
    });
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<EnrollmentPicker contact={contact} onClose={() => {}} />); });
    await act(async () => {
      renderer.root.findByType("select").props.onChange({ target: { value: sequence.id } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findAllByProps({ "aria-label": "Existing enrollments" })).toHaveLength(1);
    expect(button(renderer, "Enroll contact").props.disabled).toBe(true);
    expect(text(renderer, "alert")).toContain("already active or paused");
    expect(mocks.api.mock.calls.some(call => String(call[0]).endsWith("/enroll"))).toBe(false);
    act(() => renderer.unmount());
  });

  it("shows enrollment API failures inline without attempting enrollment", async () => {
    mocks.api.mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 }));
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<EnrollmentPicker contact={contact} onClose={() => {}} />); });
    await act(async () => {
      renderer.root.findByType("select").props.onChange({ target: { value: sequence.id } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(text(renderer, "alert")).toContain("not available on this server yet");
    expect(button(renderer, "Enroll contact").props.disabled).toBe(true);
    act(() => renderer.unmount());
  });
});

describe("Contact detail enrollment trigger", () => {
  function mockDetailApi(resource: string) {
    mocks.api.mockImplementation(async (path: string) => {
      const request = String(path);
      if (request === `/${resource}/${contact.id}`) return contact;
      if (request.includes("/enrollments")) return { data: [], total: 0 };
      if (request.endsWith(`/sequences/${sequence.id}`)) return sequence;
      if (request.endsWith("/enroll")) return { enrolled: 1, skipped: 0, enrollments: [enrollment] };
      return [];
    });
  }

  async function mountDetail(resource: string) {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<RecordDetailPage resource={resource} fields={contactFields} title={resource === "contacts" ? "Contacts" : resource} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    return renderer;
  }

  it.each(["owner", "Owner", "admin", "member"])("renders the trigger for %s on contact detail", async (role) => {
    mocks.role = role;
    mockDetailApi("contacts");
    const renderer = await mountDetail("contacts");
    expect(button(renderer, "Enroll in sequence")).toBeTruthy();
    act(() => renderer.unmount());
  });

  it("opens the enrollment drawer with the contact identity and posts the contact id", async () => {
    mocks.role = "member";
    mockDetailApi("contacts");
    const renderer = await mountDetail("contacts");
    await act(async () => { button(renderer, "Enroll in sequence").props.onClick(); });
    expect(renderer.root.findByType("h2").props.children).toBe("Enroll contact in sequence");
    expect(renderer.root.findAll(node => typeof node.type === "string" && node.props.children === `${contact.name} · ${contact.email}`)).toHaveLength(1);
    await act(async () => {
      renderer.root.findByType("select").props.onChange({ target: { value: sequence.id } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(button(renderer, "Enroll contact").props.disabled).toBe(false);
    await act(async () => {
      button(renderer, "Enroll contact").props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    const call = mocks.api.mock.calls.find(entry => String(entry[0]).endsWith("/enroll"));
    expect(call?.[1]).toEqual({ method: "POST", body: { contactIds: [contact.id] } });
    act(() => renderer.unmount());
  });

  it.each(["leads", "companies"])("does not render the trigger on %s detail", async (resource) => {
    mocks.role = "member";
    mockDetailApi(resource);
    const renderer = await mountDetail(resource);
    expect(renderer.root.findAllByType("button").some(node => node.props.children === "Enroll in sequence")).toBe(false);
    act(() => renderer.unmount());
  });

  it("does not render the trigger for viewers", async () => {
    mocks.role = "viewer";
    mockDetailApi("contacts");
    const renderer = await mountDetail("contacts");
    expect(renderer.root.findAllByType("button").some(node => node.props.children === "Enroll in sequence")).toBe(false);
    act(() => renderer.unmount());
  });
});
