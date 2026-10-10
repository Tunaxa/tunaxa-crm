import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelinePage } from "../PipelinePage";
import { PipelineEditor } from "./PipelineEditor";
import { LEGACY_PIPELINE } from "./pipelineDefinitions";
import { RecordForm } from "../../../components/records/RecordForm";

const mocks = vi.hoisted(() => ({ definitions: vi.fn(), deals: vi.fn(), role: "member", selected: "" }));
vi.mock("./usePipelineDefinitions", () => ({ usePipelineDefinitions: mocks.definitions }));
vi.mock("../../../lib/useResource", () => ({ useResource: mocks.deals }));
vi.mock("../../../components/records/useSchema", () => ({ useSchema: () => [] }));
vi.mock("../../../context/AppContext", () => ({ useApp: () => ({ user: { role: mocks.role }, toast: vi.fn() }) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
const primary = { ...LEGACY_PIPELINE, id: "a", name: "Sales" };
const enterprise = { id: "b", name: "Enterprise", stages: [{ key: "enterprise_review", label: "Enterprise review", probability: 65, order: 0 }] };
const definitionState = (patch = {}) => ({ definitions: [primary, enterprise], loading: false, error: "", saving: false, load: vi.fn(), save: vi.fn(), ...patch });
const dealState = (patch = {}) => ({ items: [{ id: "one", title: "Sales deal", stage: "new", pipelineId: "a" }, { id: "two", title: "Enterprise deal", stage: "enterprise_review", pipelineId: "b" }, { id: "three", title: "Unmapped deal", stage: "removed", pipelineId: "a" }, { id: "four", title: "Orphaned deal", pipelineId: "deleted" }], loading: false, error: "", load: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), ...patch });
beforeEach(() => {
  mocks.role = "member"; mocks.selected = "";
  mocks.definitions.mockReturnValue(definitionState()); mocks.deals.mockReturnValue(dealState());
  vi.stubGlobal("localStorage", { getItem: () => mocks.selected });
});
afterEach(() => vi.unstubAllGlobals());

describe("Multi-pipeline UI", () => {
  it("shows primary pipeline deals, stage probabilities and retained CSV controls", () => {
    const html = renderToStaticMarkup(<PipelinePage />);
    expect(html).toContain("Sales deal"); expect(html).not.toContain("Enterprise deal");
    expect(html).toContain("10% win probability"); expect(html).toContain("Import CSV");
    expect(html).toContain("Create pipeline"); expect(html).toContain("Edit pipeline");
    expect(html).toContain("Unmapped deal"); expect(html).toContain("Unmapped stages");
  });
  it("uses the stored selection to switch both stages and deals", () => {
    mocks.selected = "b";
    const html = renderToStaticMarkup(<PipelinePage />);
    expect(html).toContain("Enterprise deal"); expect(html).not.toContain("Sales deal");
    expect(html).toContain("Enterprise review"); expect(html).toContain("65% win probability");
  });
  it("keeps deals with unavailable pipelines visible in their own view", () => {
    mocks.selected = "__unassigned_pipeline__";
    expect(renderToStaticMarkup(<PipelinePage />)).toContain("Orphaned deal");
  });
  it("keeps the existing board visible when the new endpoint is unavailable", () => {
    mocks.definitions.mockReturnValue(definitionState({ definitions: [], error: "Multiple pipelines are not available" }));
    const html = renderToStaticMarkup(<PipelinePage />);
    expect(html).toContain("Sales deal"); expect(html).toContain("Retry pipelines");
    expect(html).toContain("Multiple pipelines are not available");
  });
  it("hides write controls and drag support for viewers", () => {
    mocks.role = "viewer";
    const html = renderToStaticMarkup(<PipelinePage />);
    expect(html).not.toContain("Create pipeline"); expect(html).not.toContain("Edit pipeline");
    expect(html).not.toContain('draggable="true"'); expect(html).toContain("Read-only access");
  });
  it("shows API failures separately from an empty board", () => {
    mocks.deals.mockReturnValue(dealState({ error: "Request failed" }));
    const html = renderToStaticMarkup(<PipelinePage />);
    expect(html).toContain("Request failed"); expect(html).not.toContain("No deals</h3>");
  });
  it("renders an editor with occupied stage removal disabled", () => {
    const html = renderToStaticMarkup(<PipelineEditor initial={enterprise} occupied={["enterprise_review"]} busy={false} onClose={() => {}} onSave={async () => {}} />);
    expect(html).toContain("Enterprise review"); expect(html).toContain("Contains deals; removal is disabled");
    expect(html).toContain('aria-label="Remove stage 1" disabled=""');
    expect(html).toContain('min="0" max="100"');
  });
  it("renders stage labels while submitting stable values in the shared editor", () => {
    const html = renderToStaticMarkup(<RecordForm title="Deal" fields={[{ key: "stage", label: "Stage", type: "select", options: ["enterprise_review"], optionLabels: { enterprise_review: "Enterprise review" } }]} initial={{}} onClose={() => {}} onSave={async () => {}} />);
    expect(html).toContain('value="enterprise_review"'); expect(html).toContain(">Enterprise review</option>");
  });
});
