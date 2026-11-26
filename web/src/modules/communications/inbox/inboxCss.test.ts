import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./inbox.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function mediaBlock(source: string, breakpoint: string): string {
  const header = `@media (max-width: ${breakpoint}) {`;
  const start = source.indexOf(header);
  if (start < 0) return "";
  let depth = 0;
  for (let index = start + header.length - 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return "";
}

const mobile = mediaBlock(css, "768px");

describe("unified inbox stylesheet", () => {
  it("uses canonical light and dark design tokens", () => {
    for (const token of [
      "--surface",
      "--border",
      "--text",
      "--muted",
      "--primary",
      "--focus-ring",
      "--shadow-lg",
    ]) {
      expect(css).toContain(`var(${token})`);
    }
    expect(css).toContain("html.dark .inbox-message.outbound");
    expect(css).toContain(":focus-visible");
    expect(css).not.toContain("--surface-muted");
  });

  it("stacks the split pane without fixed heights or nested clipping at 375px", () => {
    expect(mobile).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(mobile).toContain("border-right: 0");
    expect(mobile).toContain("width: 100%");
    expect(mobile).toContain("margin-left: 0");
    expect(css).not.toContain("min-height: 600px");
    expect(css).not.toContain("max-width: 850px");
    expect(mobile).not.toMatch(/height:\s*\d+px/u);
    expect(css).toContain("overflow-wrap: anywhere");
  });
});
