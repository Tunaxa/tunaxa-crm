import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import {
  DataTable,
  Drawer,
  Modal,
  type DataTableColumn,
  type DataTableProps,
} from "../components/ui";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

interface Person {
  id: number;
  name: string;
  score: number;
}

const rows: Person[] = [
  { id: 1, name: "Bravo", score: 2 },
  { id: 2, name: "Alpha", score: 10 },
];

const columns: DataTableColumn<Person>[] = [
  { key: "name", label: "Name", sortable: true },
  { key: "score", label: "Score", sortable: true },
  { key: "notes", label: "Notes", sortable: false },
];

function renderTable(
  overrides: Partial<DataTableProps<Person>> = {},
) {
  return renderToStaticMarkup(
    <DataTable
      data={rows}
      columns={columns}
      rowKey={(row) => row.id}
      ariaLabel="People"
      {...overrides}
    />,
  );
}

function tableHeaderBlocks(markup: string): string[] {
  return markup.match(/<th\b[\s\S]*?<\/th>/g) ?? [];
}

function dialogTag(markup: string, element: "section" | "aside"): string {
  const match = markup.match(
    new RegExp(`<${element}\\b[^>]*role="dialog"[^>]*>`),
  );
  if (!match) throw new Error(`no <${element} role="dialog"> in markup`);
  return match[0];
}

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`));
  return match ? match[1] : null;
}

describe("DataTable semantics", () => {
  it("renders a named table with scoped column headers", () => {
    const markup = renderTable();

    expect(markup).toContain("<table");
    expect(markup).toContain('class="data-table"');
    expect(markup).toContain('aria-label="People"');
    expect(markup.match(/scope="col"/g)).toHaveLength(columns.length);
  });

  it("puts aria-sort on the column header and never on the sort button", () => {
    const markup = renderTable();
    const headers = tableHeaderBlocks(markup);

    expect(headers).toHaveLength(columns.length);
    expect(headers[0]).toContain('aria-sort="none"');
    expect(headers[1]).toContain('aria-sort="none"');
    expect(headers[2]).not.toContain("aria-sort");

    expect(markup).not.toMatch(/<button\b[^>]*aria-sort/);
    expect(markup).toMatch(
      /<button[^>]*class="data-table-sort-btn"[^>]*>Name/,
    );
  });

  it("renders plain text instead of a disabled button for non-sortable columns", () => {
    const markup = renderTable();
    const notesHeader = tableHeaderBlocks(markup).find((header) =>
      header.includes("Notes"),
    );

    expect(notesHeader).toBeDefined();
    expect(notesHeader).not.toContain("<button");
    expect(notesHeader).not.toContain("disabled");
    expect(notesHeader).toContain(
      '<span class="data-table-sort-label">Notes</span>',
    );
  });

  it("exposes pagination as a navigation landmark with a live region", () => {
    const markup = renderTable();

    expect(markup).toContain(
      '<nav class="data-table-pagination" aria-label="Table pagination">',
    );
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("Page 1 of 1");
  });

  it("renders the empty state row inside the table body", () => {
    const markup = renderTable({ data: [] });

    expect(markup).toContain("No records found.");
    expect(markup).toMatch(/<td[^>]*class="data-table-empty"[^>]*>/);
    expect(markup).not.toContain("aria-busy");
  });

  it("marks the table busy and shows a loading row while loading", () => {
    const markup = renderTable({ data: [], loading: true });

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("Loading…");
    expect(markup).not.toContain("No records found.");
  });

  it("exposes each resizer as a vertical separator with bounds and a name", () => {
    const markup = renderTable();
    const resizers = markup.match(/<span[^>]*class="data-table-resizer"[^>]*>/g);

    expect(resizers).toHaveLength(columns.length);

    const nameResizer = resizers?.[0] ?? "";
    expect(attribute(nameResizer, "role")).toBe("separator");
    expect(attribute(nameResizer, "aria-orientation")).toBe("vertical");
    expect(attribute(nameResizer, "aria-label")).toBe("Resize Name column");
    expect(attribute(nameResizer, "aria-valuenow")).toBe("160");
    expect(attribute(nameResizer, "aria-valuemin")).toBe("80");
    expect(attribute(nameResizer, "aria-valuemax")).toBe("600");
    expect(attribute(nameResizer, "tabindex")).toBe("0");
  });

  it("updates aria-sort on the header as sorting changes state", () => {
    let renderer: ReactTestRenderer | undefined;

    act(() => {
      renderer = create(
        <DataTable
          data={rows}
          columns={columns}
          rowKey={(row) => row.id}
          ariaLabel="People"
        />,
      );
    });

    if (!renderer) throw new Error("DataTable did not render");

    const mounted = renderer;
    const headers = () =>
      mounted.root.findAll((node) => node.type === "th");
    const sortableButtons = () =>
      mounted.root
        .findAll((node) => node.type === "button")
        .filter((node) => String(node.props["aria-label"]).startsWith("Sort by "));

    expect(headers().map((header) => header.props["aria-sort"])).toEqual([
      "none",
      "none",
      undefined,
    ]);
    expect(sortableButtons()).toHaveLength(2);
    expect(
      sortableButtons().some((button) => "aria-sort" in button.props),
    ).toBe(false);

    act(() => sortableButtons()[0].props.onClick());

    expect(headers().map((header) => header.props["aria-sort"])).toEqual([
      "ascending",
      "none",
      undefined,
    ]);

    act(() => sortableButtons()[0].props.onClick());

    expect(headers().map((header) => header.props["aria-sort"])).toEqual([
      "descending",
      "none",
      undefined,
    ]);

    act(() => mounted.unmount());
  });

  it("resizes a column with ArrowLeft and ArrowRight within bounds", () => {
    let renderer: ReactTestRenderer | undefined;

    act(() => {
      renderer = create(
        <DataTable
          data={rows}
          columns={columns}
          rowKey={(row) => row.id}
          ariaLabel="People"
        />,
      );
    });

    if (!renderer) throw new Error("DataTable did not render");

    const mounted = renderer;
    const nameResizer = () =>
      mounted.root.find(
        (node) =>
          node.type === "span" &&
          node.props.role === "separator" &&
          node.props["aria-label"] === "Resize Name column",
      );

    expect(nameResizer().props["aria-valuenow"]).toBe(160);

    act(() =>
      nameResizer().props.onKeyDown({
        key: "ArrowRight",
        shiftKey: false,
        preventDefault() {},
      }),
    );
    expect(nameResizer().props["aria-valuenow"]).toBe(176);

    act(() =>
      nameResizer().props.onKeyDown({
        key: "ArrowLeft",
        shiftKey: false,
        preventDefault() {},
      }),
    );
    expect(nameResizer().props["aria-valuenow"]).toBe(160);

    act(() =>
      nameResizer().props.onKeyDown({
        key: "ArrowLeft",
        shiftKey: true,
        preventDefault() {},
      }),
    );
    expect(nameResizer().props["aria-valuenow"]).toBe(112);

    for (let step = 0; step < 40; step += 1) {
      act(() =>
        nameResizer().props.onKeyDown({
          key: "ArrowLeft",
          shiftKey: true,
          preventDefault() {},
        }),
      );
    }
    expect(nameResizer().props["aria-valuenow"]).toBe(80);

    act(() => mounted.unmount());
  });
});

describe("Modal and Drawer accessible names", () => {
  it("labels the Modal dialog with its rendered heading", () => {
    const markup = renderToStaticMarkup(
      <Modal title="Members" onClose={() => {}}>
        <p>Body</p>
      </Modal>,
    );
    const dialog = dialogTag(markup, "section");
    const titleId = attribute(dialog, "aria-labelledby");

    expect(attribute(dialog, "aria-modal")).toBe("true");
    expect(attribute(dialog, "aria-label")).toBeNull();
    expect(titleId).toBeTruthy();
    expect(markup).toContain(`<h3 id="${titleId}">Members</h3>`);
  });

  it("labels the Drawer dialog with its heading and describes it with the subtitle", () => {
    const markup = renderToStaticMarkup(
      <Drawer title="Contact" subtitle="Edit details" onClose={() => {}}>
        <p>Body</p>
      </Drawer>,
    );
    const dialog = dialogTag(markup, "aside");
    const titleId = attribute(dialog, "aria-labelledby");
    const subtitleId = attribute(dialog, "aria-describedby");

    expect(attribute(dialog, "aria-modal")).toBe("true");
    expect(attribute(dialog, "aria-label")).toBeNull();
    expect(titleId).toBeTruthy();
    expect(subtitleId).toBeTruthy();
    expect(markup).toContain(`<h2 id="${titleId}">Contact</h2>`);
    expect(markup).toContain(`<p id="${subtitleId}">Edit details</p>`);
  });

  it("omits aria-describedby when the Drawer has no subtitle", () => {
    const markup = renderToStaticMarkup(
      <Drawer title="Contact" onClose={() => {}}>
        <p>Body</p>
      </Drawer>,
    );
    const dialog = dialogTag(markup, "aside");

    expect(attribute(dialog, "aria-labelledby")).toBeTruthy();
    expect(attribute(dialog, "aria-describedby")).toBeNull();
  });
});
