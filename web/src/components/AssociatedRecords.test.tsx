import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { associationGroups, AssociationPanel, openRelatedRecords } from "./AssociatedRecords";

describe("contact associations", () => {
  it("keeps open deals and excludes terminal stages and statuses", () => {
    expect(openRelatedRecords([
      { id: "open", stage: "Negotiation", value: 0 },
      { id: "won", stage: " WON " },
      { id: "lost", status: "Closed Lost" },
    ], "deals").map((row) => row.id)).toEqual(["open"]);
  });
  it("excludes completed and cancelled tasks", () => {
    expect(openRelatedRecords([
      { id: "open", completed: false },
      { id: "done", completed: true },
      { id: "cancelled", status: "Cancelled" },
    ], "tasks").map((row) => row.id)).toEqual(["open"]);
  });
  it("rejects invalid API shapes and ignores invalid records", () => {
    expect(() => associationGroups(null)).toThrow();
    expect(() => associationGroups({ companies: [] })).toThrow();
    expect(associationGroups({ companies: [null, { name: "No id" }, { id: "1", name: "Company" }], deals: [], tasks: [], meetings: [] }).companies).toHaveLength(1);
  });
  it("renders details in place, preserving zero and escaping stored text", () => {
    const html = renderToStaticMarkup(<AssociationPanel title="Open Deals" records={[{ id: "1", title: "<script>alert(1)</script>", value: 0, owner: "Alice" }]} />);
    expect(html).toContain("<details");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<dd>0</dd>");
    expect(html).toContain("Alice");
    expect(html).not.toContain("href=");
  });
  it("shows an explicit empty panel", () => {
    expect(renderToStaticMarkup(<AssociationPanel title="Open Tasks" records={[]} />)).toContain("No open tasks.");
  });
});
