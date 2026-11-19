import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomReportBuilder } from "./CustomReportBuilder";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const state = vi.hoisted(() => ({
  api: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  api: (path: string, options?: unknown) => state.api(path, options),
  json: (method: string, body?: unknown) => ({
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  }),
}));

const mounted: ReactTestRenderer[] = [];

function mount(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<CustomReportBuilder />);
  });
  mounted.push(renderer);
  return renderer;
}

function submitButton(renderer: ReactTestRenderer) {
  return renderer.root.findByProps({ type: "submit" });
}

function reportForm(renderer: ReactTestRenderer) {
  return renderer.root.findByType("form");
}

function dateInputs(renderer: ReactTestRenderer) {
  return renderer.root.findAll(
    (node) => node.type === "input" && node.props.type === "date",
  );
}

function heading(renderer: ReactTestRenderer, text: string) {
  return renderer.root.findAll(
    (node) => node.type === "h2" && node.children.join("") === text,
  );
}

beforeEach(() => {
  state.api.mockReset();
  state.api.mockResolvedValue({ rows: [{ stage: "Won", count: 4 }] });
});

afterEach(() => {
  while (mounted.length) {
    const renderer = mounted.pop()!;
    act(() => renderer.unmount());
  }
});

describe("CustomReportBuilder", () => {
  it("renders the report builder heading and submit button", () => {
    const renderer = mount();

    expect(heading(renderer, "Build Report")).toHaveLength(1);
    expect(
      renderer.root.findAll(
        (node) =>
          node.type === "p" &&
          node.children.join("") ===
            "Create a grouped report using your CRM data.",
      ),
    ).toHaveLength(1);
    expect(submitButton(renderer).children.join("")).toContain("Run Report");
    expect(submitButton(renderer).props.disabled).toBe(false);
  });

  it("renders entity, metric, filter, and date-range controls", () => {
    const renderer = mount();
    let selects = renderer.root.findAllByType("select");

    expect(selects).toHaveLength(3);
    expect(selects[0].props.value).toBe("deals");
    expect(
      selects[0].findAllByType("option").map((option) => option.props.value),
    ).toEqual(["deals", "contacts", "leads"]);
    expect(selects[1].props.value).toBe("count");
    expect(
      selects[1]
        .findAllByType("option")
        .map((option) => option.children.join("")),
    ).toEqual(["Count", "Sum of Value", "Average"]);
    expect(selects[2].props.value).toBe("stage");
    expect(
      selects[2].findAllByType("option").map((option) => option.props.value),
    ).toEqual(["stage", "owner", "status", "company"]);

    expect(
      renderer.root.findByProps({
        role: "group",
        "aria-label": "Choose date range",
      }),
    ).toBeTruthy();
    expect(dateInputs(renderer)).toHaveLength(2);

    act(() => {
      selects[0].props.onChange({ target: { value: "leads" } });
    });
    selects = renderer.root.findAllByType("select");
    expect(selects[0].props.value).toBe("leads");
    expect(selects[2].props.value).toBe("status");
    expect(
      selects[2].findAllByType("option").map((option) => option.props.value),
    ).toEqual(["status", "source", "owner", "company"]);

    act(() => {
      selects[1].props.onChange({ target: { value: "sum" } });
    });
    expect(renderer.root.findAllByType("select")[1].props.value).toBe("sum");
  });

  it("runs a report query with the selected controls and renders results", async () => {
    const renderer = mount();

    act(() => {
      dateInputs(renderer)[0].props.onChange({ target: { value: "2026-11-01" } });
    });
    act(() => {
      dateInputs(renderer)[1].props.onChange({ target: { value: "2026-11-19" } });
    });

    await act(async () => {
      await reportForm(renderer).props.onSubmit({ preventDefault: () => {} });
    });

    expect(state.api).toHaveBeenCalledTimes(1);
    const [path, options] = state.api.mock.calls[0];
    expect(path).toBe("/reports/query");
    expect(options).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(options.body))).toEqual({
      entity: "deals",
      metric: "count",
      groupBy: "stage",
      dateRange: { start: "2026-11-01", end: "2026-11-19" },
    });

    expect(
      renderer.root.findAll(
        (node) =>
          node.type === "h3" && node.children.join("") === "Report results",
      ),
    ).toHaveLength(1);
    expect(renderer.root.findAllByType("table")).toHaveLength(1);
    expect(
      renderer.root
        .findAllByType("td")
        .map((cell) => cell.children.join("")),
    ).toContain("Won");
    expect(
      renderer.root
        .findAllByType("td")
        .map((cell) => cell.children.join("")),
    ).toContain("4");
    expect(submitButton(renderer).children.join("")).toContain("Run Report");
    expect(submitButton(renderer).props.disabled).toBe(false);
  });
});
