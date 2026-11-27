import { Icon } from "../../../components/Icon";
import { Badge } from "../../../components/ui";
import {
  dateLabel,
  dateTime,
  validDate,
  type Message,
} from "./inboxModel";

type Tone = "green" | "amber" | "blue";

type IndicatorProps = {
  label: string;
  icon: string;
  tone: Tone;
  at: string;
  count: number;
};

function TrackingPill({ label, icon, tone, at, count }: IndicatorProps) {
  const value = dateTime(at);
  const when = value ? dateLabel(at) : "time unavailable";
  const suffix = count > 1 ? `, ${count} times` : "";
  return (
    <span
      className="inbox-tracking-pill"
      data-tone={tone}
      aria-label={`${label} ${when}${suffix}`}
    >
      <Icon name={icon} size={14} />
      <span>{label}</span>
      {value && <time dateTime={value}>{when}</time>}
      {count > 1 && <Badge tone="neutral">{count}×</Badge>}
    </span>
  );
}

export function TrackingIndicators({ message }: { message: Message }) {
  const indicators: IndicatorProps[] = [];
  if (validDate(message.deliveredAt)) {
    indicators.push({
      label: "Delivered",
      icon: "mail",
      tone: "green",
      at: message.deliveredAt,
      count: 0,
    });
  }
  if (validDate(message.openedAt)) {
    indicators.push({
      label: "Opened",
      icon: "eye",
      tone: "amber",
      at: message.openedAt,
      count: message.openCount,
    });
  }
  if (validDate(message.clickedAt)) {
    indicators.push({
      label: "Clicked",
      icon: "globe",
      tone: "blue",
      at: message.clickedAt,
      count: message.clickCount,
    });
  }
  if (!indicators.length) return null;
  return (
    <span className="inbox-tracking">
      {indicators.map((indicator) => (
        <TrackingPill key={indicator.label} {...indicator} />
      ))}
    </span>
  );
}
