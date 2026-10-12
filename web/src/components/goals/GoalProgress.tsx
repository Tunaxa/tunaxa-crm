type GoalValue = number | string | null | undefined;
type GoalTone = "red" | "amber" | "green";

const milestones = [50, 75, 100] as const;
export type GoalMilestone = (typeof milestones)[number];
const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

export function getGoalProgress(currentValue: GoalValue, targetValue: GoalValue) {
  const parsedCurrent = Number(currentValue);
  const parsedTarget = Number(targetValue);
  const current = Number.isFinite(parsedCurrent) ? parsedCurrent : 0;
  const target = Number.isFinite(parsedTarget) ? parsedTarget : 0;
  const percent = target > 0 ? Math.max(0, (current / target) * 100) : 0;
  const tone: GoalTone =
    percent < 50 ? "red" : percent <= 75 ? "amber" : "green";

  return {
    current,
    target,
    percent,
    barPercent: Math.min(percent, 100),
    tone,
  };
}

export function getCrossedGoalMilestone(
  previousCurrent: GoalValue,
  previousTarget: GoalValue,
  nextCurrent: GoalValue,
  nextTarget: GoalValue,
): GoalMilestone | null {
  const previousPercent = getGoalProgress(
    previousCurrent,
    previousTarget,
  ).percent;
  const nextPercent = getGoalProgress(nextCurrent, nextTarget).percent;

  return (
    [...milestones]
      .reverse()
      .find(
        (milestone) => previousPercent < milestone && nextPercent >= milestone,
      ) ?? null
  );
}

export function GoalProgress({
  name,
  current,
  target,
}: {
  name: string;
  current: GoalValue;
  target: GoalValue;
}) {
  const progress = getGoalProgress(current, target);
  const displayedPercent = Math.floor(progress.percent);
  const hasTarget = progress.target > 0;

  return (
    <div className={`goal-progress goal-progress--${progress.tone}`}>
      <div className="goal-progress-summary">
        <span>
          {numberFormat.format(progress.current)} / {numberFormat.format(progress.target)}
        </span>
        <strong>{hasTarget ? `${displayedPercent}%` : "Set target"}</strong>
      </div>
      <div
        className="goal-progress-track"
        role="progressbar"
        aria-label={`${name} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.floor(progress.barPercent)}
        aria-valuetext={hasTarget
          ? `${numberFormat.format(progress.current)} of ${numberFormat.format(progress.target)}, ${displayedPercent}%`
          : `${numberFormat.format(progress.current)} current, no target set`}
      >
        <span style={{ width: `${progress.barPercent}%` }} />
      </div>
      <div className="goal-milestones" aria-label="Goal milestones">
        {milestones.map((milestone) => (
          <span
            key={milestone}
            className={progress.percent >= milestone ? "reached" : ""}
            title={`${milestone}% milestone ${progress.percent >= milestone ? "reached" : "not reached"}`}
          >
            {milestone}%
          </span>
        ))}
      </div>
    </div>
  );
}
