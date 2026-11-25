import { describe, expect, it } from "vitest";
import {
  dealPayload,
  defaultDefinition,
  definitionPayload,
  parseDefinition,
  pipelineDeals,
  pipelinePayload,
  type PipelineDefinition,
} from "./pipelineDefinitions";

const definitions: PipelineDefinition[] = [
  {
    id: "pipeline-a",
    name: "Pipeline A",
    entityType: "deal",
    isDefault: false,
    stages: [{ key: "new", label: "New", probability: 10, order: 0 }],
  },
  {
    id: "pipeline-b",
    name: "Pipeline B",
    entityType: "deal",
    isDefault: true,
    stages: [{ key: "lead", label: "Lead", probability: 75, order: 0 }],
  },
];

describe("pipelinePayload", () => {
  it("trims names and normalizes stage order and probability", () => {
    const payload = pipelinePayload("  Alpha  ", [
      { key: "new", label: " New ", probability: "10" },
      { key: "won", label: "Won", probability: "100" },
    ]);
    expect(payload).toEqual({
      name: "Alpha",
      entityType: "deal",
      isDefault: false,
      stages: [
        { key: "new", label: "New", probability: 10, order: 0 },
        { key: "won", label: "Won", probability: 100, order: 1 },
      ],
    });
  });

  it("rejects decimal, out-of-range and non-integer probabilities", () => {
    for (const value of ["10.5", "-1", "101", "NaN"]) {
      expect(() =>
        pipelinePayload("Alpha", [
          { key: "new", label: "New", probability: value },
        ]),
      ).toThrow();
    }
  });

  it("rejects reserved, malformed and duplicate stage keys", () => {
    for (const key of ["__proto__", "constructor", "prototype", "bad key", "-start"]) {
      expect(() =>
        pipelinePayload("Alpha", [
          { key, label: "New", probability: "10" },
        ]),
      ).toThrow();
    }
    expect(() =>
      pipelinePayload("Alpha", [
        { key: "New", label: "One", probability: "10" },
        { key: "new", label: "Two", probability: "20" },
      ]),
    ).toThrow(/unique/i);
  });

  it("enforces stage count and name bounds", () => {
    expect(() =>
      pipelinePayload("Alpha", []),
    ).toThrow(/1 and 20/i);
    expect(() =>
      pipelinePayload("   ", [{ key: "new", label: "New", probability: "10" }]),
    ).toThrow(/1-100/i);
    expect(() =>
      pipelinePayload("Alpha", [
        { key: "new", label: "", probability: "10" },
      ]),
    ).toThrow(/1-100/i);
  });
});

describe("definition helpers", () => {
  it("uses the server default definition for unbound deals", () => {
    expect(defaultDefinition(definitions)?.id).toBe("pipeline-b");
    const deals = [
      { id: "deal-1", title: "Explicit", stage: "new", pipelineId: "pipeline-a" },
      { id: "deal-2", title: "Unbound", stage: "lead" },
    ];
    expect(pipelineDeals(deals, "pipeline-a", definitions).map((row) => row.id)).toEqual([
      "deal-1",
    ]);
    expect(pipelineDeals(deals, "pipeline-b", definitions).map((row) => row.id)).toEqual([
      "deal-2",
    ]);
  });

  it("validates server definitions before using them", () => {
    expect(() =>
      parseDefinition({
        id: "pipeline-c",
        name: "Pipeline C",
        entityType: "deal",
        isDefault: false,
        stages: [{ key: "new", label: "New", probability: 10.5, order: 0 }],
      }),
    ).toThrow();
  });

  it("builds a full Set Default payload", () => {
    const payload = definitionPayload(definitions[0], { isDefault: true });
    expect(payload.isDefault).toBe(true);
    expect(payload.name).toBe("Pipeline A");
    expect(payload.stages[0]).toEqual({
      key: "new",
      label: "New",
      probability: 10,
      order: 0,
    });
  });

  it("adds pipeline and probability to deal payloads and rejects unsafe keys", () => {
    const payload = dealPayload({ title: "Deal", stage: "lead" }, definitions[1]);
    expect(payload).toEqual({
      title: "Deal",
      stage: "lead",
      probability: 75,
      pipelineId: "pipeline-b",
    });
    expect(() =>
      dealPayload({ title: "Deal", stage: "lead", constructor: "x" }, definitions[1]),
    ).toThrow(/reserved/i);
  });
});
