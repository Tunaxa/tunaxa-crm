import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SequencesPage } from "./SequencesPage";
import { SequenceEditor } from "./SequenceEditor";
import { ContactSequenceEnrollment, EnrollmentPicker } from "./ContactSequenceEnrollment";
const mocks = vi.hoisted(() => ({ resource: vi.fn(), role: "member" }));
vi.mock("../../../lib/useResource", () => ({ useResource: mocks.resource }));
vi.mock("../../../context/AppContext", () => ({ useApp: () => ({ user: { role: mocks.role }, toast: vi.fn() }) }));
const sequence = { id: "seq_a", name: "Three-step outreach", enabled: true, steps: [0, 2, 5].map((delayDays, index) => ({ id: `step_${index}`, subject: `Subject ${index + 1}`, body: `Message ${index + 1}`, delayDays, action: "sendEmail" })) };
const state = (patch = {}) => ({ items: [sequence], loading: false, error: "", load: vi.fn(), ...patch });
beforeEach(() => { mocks.role = "member"; mocks.resource.mockReturnValue(state()); });

describe("Sequence UI", () => {
  it("requests the whole sequence list and displays structured steps", () => {
    const html = renderToStaticMarkup(<SequencesPage />);
    expect(mocks.resource).toHaveBeenCalledWith("sequences", { all: true });
    expect(html).toContain("3 steps"); expect(html).toContain("Subject 3"); expect(html).toContain("Wait 5 days");
    expect(html).toContain("Build sequence"); expect(html).toContain("Edit sequence"); expect(html).toContain("Disable enrollment");
  });
  it("preserves unsupported legacy text and disables its email editor", () => {
    mocks.resource.mockReturnValue(state({ items: [{ ...sequence, steps: "Legacy description" }] }));
    const html = renderToStaticMarkup(<SequencesPage />);
    expect(html).toContain("Legacy description"); expect(html).toContain("configuration is preserved");
    expect(html).toContain('disabled="">Edit sequence');
  });
  it("hides mutation controls for a viewer", () => {
    mocks.role = "viewer";
    const html = renderToStaticMarkup(<SequencesPage />);
    expect(html).not.toContain("Build sequence</button>"); expect(html).not.toContain("Edit sequence"); expect(html).not.toContain("Delete sequence");
    expect(renderToStaticMarkup(<ContactSequenceEnrollment contact={{ id: "contact_a", email: "person@example.com" }} />)).toBe("");
  });
  it("shows API failures separately from empty and loading states", () => {
    mocks.resource.mockReturnValue(state({ loading: true }));
    expect(renderToStaticMarkup(<SequencesPage />)).toContain("Loading sequences");
    mocks.resource.mockReturnValue(state({ error: "Request failed" }));
    expect(renderToStaticMarkup(<SequencesPage />)).toContain("Retry");
    mocks.resource.mockReturnValue(state({ items: [] }));
    expect(renderToStaticMarkup(<SequencesPage />)).toContain("No sequences yet");
  });
  it("renders an editor with all three steps, delays and message fields", () => {
    const html = renderToStaticMarkup(<SequenceEditor initial={sequence} onClose={() => {}} onSave={async () => {}} />);
    expect(html).toContain("Email 3"); expect(html).toContain("Message 3"); expect(html).toContain("Wait Minutes");
    expect(html).toContain("Add email step"); expect(html).toContain('aria-label="Move email 1 up" disabled=""');
  });
  it("offers enrollment from a contact and requires an explicit choice and status check", () => {
    const contact = { id: "contact_a", name: "Ada", email: "ada@example.com" };
    expect(renderToStaticMarkup(<ContactSequenceEnrollment contact={contact} />)).toContain("Enroll in sequence");
    const html = renderToStaticMarkup(<EnrollmentPicker contact={contact} onClose={() => {}} />);
    expect(html).toContain("Ada"); expect(html).toContain("Three-step outreach");
    expect(html).toContain('disabled="">Enroll contact');
    expect(html).not.toContain("Contact enrolled");
  });
});
