import { describe, expect, it } from "vitest";
import { checkDealSave, dealPayload, importDealPayload, LEGACY_PIPELINE, occupiedStageKeys, ORPHAN_PIPELINE, parseDefinitions, pipelineDeals, pipelinePayload, stageForDeal, validateStageRemoval, type PipelineDefinition } from "./pipelineDefinitions";
import { parseCsv, prepareRows } from "../../../components/imports/csvImport";

const first: PipelineDefinition = { id: "pipeline_a", name: "Sales", stages: [{ key: "lead", label: "Lead", probability: 20, order: 0 }, { key: "won", label: "Won", probability: 100, order: 1 }] };
const second: PipelineDefinition = { id: "pipeline_b", name: "Enterprise", stages: [{ key: "review", label: "Review", probability: 60, order: 0 }] };

describe("Pipeline definitions and editing", () => {
  it("sends stable stage keys, trimmed names, decimal probabilities and sequential order", () => {
    const payload = pipelinePayload(" Sales ", [{ key: "won", label: "Closed won", probability: "100" }, { key: "lead", label: "Discovery", probability: "12.5" }]);
    expect(payload).toEqual({ name: "Sales", stages: [{ key: "won", label: "Closed won", probability: 100, order: 0 }, { key: "lead", label: "Discovery", probability: 12.5, order: 1 }] });
  });
  it.each(["", "-1", "101", "Infinity", "bad"])("rejects an invalid probability (%j)", probability => {
    expect(() => pipelinePayload("Sales", [{ key: "lead", label: "Lead", probability }])).toThrow("between 0 and 100");
  });
  it("rejects missing names, empty stage lists and duplicate stage names or keys", () => {
    expect(() => pipelinePayload(" ", [])).toThrow("name");
    expect(() => pipelinePayload("Sales", [])).toThrow("one stage");
    expect(() => pipelinePayload("Sales", [{ key: "a", label: "Lead", probability: "10" }, { key: "A", label: "Won", probability: "100" }])).toThrow("keys");
    expect(() => pipelinePayload("Sales", [{ key: "a", label: "Lead", probability: "10" }, { key: "b", label: "lead", probability: "100" }])).toThrow("names");
  });
  it("sorts returned stages without changing primary pipeline order", () => {
    const rows = parseDefinitions([{ ...first, stages: [...first.stages].reverse() }, second]);
    expect(rows.map(row => row.id)).toEqual([first.id, second.id]);
    expect(rows[0].stages.map(stage => stage.key)).toEqual(["lead", "won"]);
  });
  it.each([{}, [first, first], [{ ...first, stages: [{ key: "bad", probability: -1 }] }]])("rejects malformed API definitions (%j)", response => {
    expect(() => parseDefinitions(response)).toThrow();
  });
  it("allows an existing zero-stage definition to be repaired by the editor", () => expect(parseDefinitions([{ ...first, stages: [] }])[0].stages).toEqual([]));
  it("blocks removing a stage that contains a deal, but permits removal of empty stages", () => {
    const rows = [{ id: "one", stage: "lead" }];
    expect(occupiedStageKeys(rows, first)).toEqual(["lead"]);
    expect(() => validateStageRemoval(first, first.stages.slice(1), rows)).toThrow("Move the deals");
    expect(() => validateStageRemoval(first, first.stages.slice(0, 1), rows)).not.toThrow();
  });
  it("keeps key-linked deals in the same stage after renaming", () => {
    const renamed = { ...first, stages: [{ ...first.stages[0], label: "Discovery" }, first.stages[1]] };
    expect(() => validateStageRemoval(first, renamed.stages, [{ id: "one", stage: "lead" }])).not.toThrow();
    expect(stageForDeal({ id: "one", stage: "lead" }, renamed)?.label).toBe("Discovery");
  });
  it("requires label-linked legacy rows to be normalized before renaming", () => {
    const legacy = { ...second, stages: [{ ...second.stages[0], key: "stable_review" }] };
    const next = [{ ...legacy.stages[0], label: "Assessment" }];
    expect(() => validateStageRemoval(legacy, next, [{ id: "one", stage: "Review" }])).toThrow("legacy deals");
  });
});

describe("Pipeline board and deal binding", () => {
  const rows = [{ id: "one", stage: "lead", pipelineId: first.id }, { id: "two", stage: "review", pipeline_id: second.id }, { id: "three", stage: "lead" }, { id: "four", pipelineId: "deleted" }];
  it("isolates deals by pipeline and defaults records with no binding to the primary definition", () => {
    expect(pipelineDeals(rows, first.id, [first, second]).map(row => row.id)).toEqual(["one", "three"]);
    expect(pipelineDeals(rows, second.id, [first, second]).map(row => row.id)).toEqual(["two"]);
    expect(pipelineDeals(rows, ORPHAN_PIPELINE, [first, second]).map(row => row.id)).toEqual(["four"]);
  });
  it("retains all existing deals when definitions are not available", () => expect(pipelineDeals(rows, "", [])).toEqual(rows));
  it("matches legacy keys and labels while leaving unknown stages visible as unmapped", () => {
    expect(stageForDeal({ id: "one", stage: "New" }, LEGACY_PIPELINE)?.key).toBe("new");
    expect(stageForDeal({ id: "one", stage: "Review" }, second)?.key).toBe("review");
    expect(stageForDeal({ id: "one", stage: "deleted" }, first)).toBeUndefined();
  });
  it("forces the selected pipeline, stage key and configured probability on new and updated deals", () => {
    expect(dealPayload({ title: "Deal", stage: "review", pipelineId: "wrong", probability: 1, customField: "keep" }, second)).toEqual({ title: "Deal", stage: "review", pipelineId: second.id, probability: 60, customField: "keep" });
    expect(() => dealPayload({ stage: "lead" }, second)).toThrow("valid stage");
  });
  it("imports stage labels as keys and binds every row to the selected pipeline", () => {
    const parsed = prepareRows(parseCsv("title,stage\nCSV deal,Review"), ["title", "stage"], [
      { key: "title", label: "Deal name", required: true }, { key: "stage", label: "Stage", type: "select", options: ["review"], optionLabels: { review: "Review" } },
    ]);
    expect(parsed[0].errors).toEqual([]);
    expect(importDealPayload(parsed[0].payload, second)).toMatchObject({ stage: "review", pipelineId: second.id, probability: 60 });
    expect(importDealPayload({ title: "Default stage" }, second).stage).toBe("review");
    expect(() => importDealPayload({ stage: "wrong" }, second)).toThrow("valid stage");
  });
  it("requires a response confirming the saved pipeline and stage", () => {
    const payload = dealPayload({ stage: "review" }, second);
    expect(() => checkDealSave({ id: "one", stage: "review", pipelineId: second.id }, payload)).not.toThrow();
    expect(() => checkDealSave({ id: "one", stage: "lead", pipelineId: second.id }, payload)).toThrow("did not confirm");
    expect(() => checkDealSave({ id: "one", stage: "review", pipelineId: first.id }, payload)).toThrow("did not confirm");
  });
});
