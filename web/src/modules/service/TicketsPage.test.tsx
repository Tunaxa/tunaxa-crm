import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TicketsPage } from "./TicketsPage";
import { boardStages } from "./ticketBoard";
import { navGroups } from "../../shell/navGroups";

const mocks = vi.hoisted(() => ({ state: vi.fn(), role: "member", toast: vi.fn() }));
vi.mock("./useTicketBoard", () => ({ useTicketBoard: mocks.state }));
vi.mock("../../context/AppContext", () => ({ useApp: () => ({ user: { role: mocks.role }, toast: mocks.toast }) }));
const rows = [
  { id: "one", subject: "Overdue support", stage: "New", createdAt: "2020-01-01T00:00:00Z", priority: "High", contact: "Alex" },
  { id: "two", subject: "Resolved support", stage: "Resolved", createdAt: "2020-01-01T00:00:00Z", priority: "Normal" },
  { id: "three", subject: "Legacy support", stage: "Legacy", priority: "Low" },
];
const state = (patch = {}) => ({ board: { data: rows, stages: boardStages(rows), total: rows.length, sla: { firstResponseHours: 4, resolutionHours: 48 } },
  loading: false, refreshing: false, error: "", saving: "", load: vi.fn(), move: vi.fn(), create: vi.fn(), ...patch });
beforeEach(() => {
  mocks.role = "member";
  mocks.toast.mockClear();
  mocks.state.mockReturnValue(state());
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { window?: unknown }).window = {
  setInterval: vi.fn(() => 1),
  clearInterval: vi.fn(),
};

describe("Tickets page", () => {
  it("renders all ticket stages, overdue clocks and accessible stage controls", () => {
    const html = renderToStaticMarkup(<TicketsPage />);
    expect(html).toContain('aria-label="Ticket Kanban board"');
    expect(html).toContain('role="region"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="Legacy tickets"');
    expect(html).toContain("Overdue by");
    expect(html).toContain("Stage for Overdue support");
    expect(html).toContain('draggable="true"');
    expect(html).toContain("Deadline unavailable");
  });
  it.each(["owner", "Owner", "admin", "member"])("keeps create and move controls available for %s", (role) => {
    mocks.role = role;
    const html = renderToStaticMarkup(<TicketsPage />);
    expect(html).toContain("Add ticket");
    expect(html).toContain('draggable="true"');
    expect(html).toContain("Drag a card or use its stage selector to move it.");
    expect(html).not.toContain("read-only access");
    expect(html).not.toContain('<span class="sr-only">Stage for Overdue support</span><select disabled=');
  });
  it("provides strictly read-only access for viewers", () => {
    mocks.role = "viewer";
    const html = renderToStaticMarkup(<TicketsPage />);
    expect(html).not.toContain("Add ticket");
    expect(html).not.toContain('draggable="true"');
    expect(html).toContain("read-only access");
    expect(html).toContain('<select disabled=""');
  });
  it("disables moves while saving", () => {
    mocks.state.mockReturnValue(state({ saving: "one" }));
    const html = renderToStaticMarkup(<TicketsPage />);
    expect(html).toContain("Saving ticket stage");
    expect(html).not.toContain('draggable="true"');
  });
  it("shows loading without claiming the board is empty", () => {
    mocks.state.mockReturnValue(state({ loading: true }));
    const html = renderToStaticMarkup(<TicketsPage />);
    expect(html).toContain("Loading tickets");
    expect(html).not.toContain("No tickets yet");
  });
  it("retains the last board but blocks moves when refresh fails", () => {
    mocks.state.mockReturnValue(state({ error: "Connection lost" }));
    const html = renderToStaticMarkup(<TicketsPage />);
    expect(html).toContain("Connection lost");
    expect(html).toContain("Overdue support");
    expect(html).toContain("last loaded board");
    expect(html).not.toContain('draggable="true"');
    expect(html).toContain("Retry");
  });
  it("keeps all four empty columns for a new workspace", () => {
    mocks.state.mockReturnValue(state({ board: { data: [], stages: boardStages([]), sla: {}, total: 0 } }));
    const html = renderToStaticMarkup(<TicketsPage />);
    expect(html).toContain("No tickets yet");
    expect(html).toContain('aria-label="Awaiting Client tickets"');
  });
  it("reports a failed stage move inline without changing the confirmed board", async () => {
    const move = vi.fn().mockRejectedValue(new Error("Invalid transition"));
    mocks.state.mockReturnValue(state({ move }));
    let renderer: ReactTestRenderer | undefined;
    await act(async () => { renderer = create(<TicketsPage />); });
    const instance = renderer as ReactTestRenderer;
    const stageSelect = instance.root.findAllByType("select").find(node => node.props.value === "New");
    expect(stageSelect).toBeDefined();

    await act(async () => {
      await stageSelect!.props.onChange({ target: { value: "In Progress" } });
    });

    const alert = instance.root.findAll(node =>
      node.type === "div" &&
      node.props.role === "alert" &&
      String(node.props.className).includes("ticket-move-error"),
    );
    expect(alert).toHaveLength(1);
    expect(alert[0].findAllByType("p")[0].children).toContain("Invalid transition");
    expect(mocks.toast).toHaveBeenCalledWith("Invalid transition", "error");
    expect(move).toHaveBeenCalledWith(rows[0], "In Progress");
    expect(instance.root.findAllByType("select").some(node => node.props.value === "New")).toBe(true);
    await act(async () => { instance.unmount(); });
  });
  it("exposes Tickets in the Service navigation", () => {
    expect(navGroups.find(group => group.label === "nav.service")?.items).toContainEqual({ path: "/tickets", label: "nav.tickets", icon: "ticket" });
  });
});
