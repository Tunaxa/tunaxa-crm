import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  GoalProgress,
  getCrossedGoalMilestone,
  getGoalProgress,
} from "./GoalProgress";

describe("goal progress thresholds", () => {
  it.each([
    [49, "red"],
    [50, "amber"],
    [75, "amber"],
    [76, "green"],
    [100, "green"],
  ] as const)("uses %s%% as %s", (current, tone) => {
    expect(getGoalProgress(current, 100).tone).toBe(tone);
  });

  it("handles missing targets and values above the target", () => {
    expect(getGoalProgress(10, 0).percent).toBe(0);
    expect(getGoalProgress(125, 100)).toMatchObject({
      percent: 125,
      barPercent: 100,
      tone: "green",
    });
  });

  it("shows the achieved milestones and accessible progress value", () => {
    const markup = renderToStaticMarkup(
      createElement(GoalProgress, { name: "Sales", current: 75, target: 100 }),
    );
    expect(markup).toContain('aria-label="Sales progress"');
    expect(markup).toContain('aria-valuenow="75"');
    expect(markup.match(/class="reached"/g)).toHaveLength(2);
  });

  it("asks for a target when none is set", () => {
    const markup = renderToStaticMarkup(
      createElement(GoalProgress, { name: "Sales", current: 10, target: 0 }),
    );
    expect(markup).toContain("Set target");
    expect(markup).toContain("no target set");
  });
});

describe("goal milestone celebrations", () => {
  it.each([
    [49, 50, 50],
    [60, 80, 75],
    [80, 100, 100],
    [40, 110, 100],
  ])(
    "detects the highest newly crossed milestone",
    (before, after, milestone) => {
      expect(getCrossedGoalMilestone(before, 100, after, 100)).toBe(milestone);
    },
  );

  it("does not celebrate unchanged or decreasing progress", () => {
    expect(getCrossedGoalMilestone(75, 100, 75, 100)).toBeNull();
    expect(getCrossedGoalMilestone(80, 100, 60, 100)).toBeNull();
  });
});
