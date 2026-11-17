import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Guards the stylesheet contracts that TypeScript/ESLint cannot see:
 * brace integrity (the #433 regression), Git conflict leftovers, the dark
 * theme token block, and the mobile shell/kanban media queries.
 *
 * Files are read directly with `node:fs` (no new dependencies). CSS cannot be
 * imported as `?raw` here because Vitest's CSS enabler stubs every `.css`
 * module to an empty string, including `?raw` imports.
 */
const STYLES_DIR = new URL("../styles/", import.meta.url);

function readStylesheet(name: string): string {
  return readFileSync(new URL(name, STYLES_DIR), "utf8").replace(/\r\n/g, "\n");
}

const appCss = readStylesheet("app.css");
const tokensCss = readStylesheet("tokens.css");

const CSS_FILES: Array<[string, string]> = [
  ["app.css", appCss],
  ["tokens.css", tokensCss],
];

const CONFLICT_MARKER = /^(?:<{7}|={7}|>{7})/m;

function countOccurrences(source: string, token: string): number {
  return source.split(token).length - 1;
}

/**
 * Extracts every top-level `@media (max-width: <breakpoint>)` block using a
 * brace-depth scan, so nested rule blocks are returned in full instead of
 * being truncated at the first `}`.
 */
function extractMediaBlocks(source: string, breakpoint: string): string[] {
  const blocks: string[] = [];
  const header = new RegExp(
    `@media\\s*\\(max-width:\\s*${breakpoint}\\)\\s*\\{`,
    "g",
  );
  let match: RegExpExecArray | null;

  while ((match = header.exec(source)) !== null) {
    let depth = 0;
    let cursor = match.index + match[0].length - 1;

    for (; cursor < source.length; cursor += 1) {
      if (source[cursor] === "{") depth += 1;
      else if (source[cursor] === "}") {
        depth -= 1;
        if (depth === 0) {
          blocks.push(source.slice(match.index, cursor + 1));
          break;
        }
      }
    }
  }

  return blocks;
}

describe("stylesheet integrity", () => {
  it.each(CSS_FILES)("%s contains no Git conflict markers", (_file, css) => {
    expect(css).not.toMatch(CONFLICT_MARKER);
    expect(css).not.toContain("<<<<<<<");
    expect(css).not.toContain("=======");
    expect(css).not.toContain(">>>>>>>");
  });

  it.each(CSS_FILES)("%s has exact { } brace parity", (_file, css) => {
    expect(countOccurrences(css, "{")).toBe(countOccurrences(css, "}"));
  });

  it("app.css ends with exactly one trailing newline", () => {
    expect(appCss.endsWith("\n")).toBe(true);
    expect(appCss.endsWith("\n\n")).toBe(false);
  });
});

describe("dark theme", () => {
  it("defines the html.dark custom property block", () => {
    const declarations =
      /html\.dark\s*\{([^}]*)\}/.exec(appCss)?.[1] ?? "";

    // Note: this design system has no `--ink-1` token; the primary text token
    // is `--ink-primary`, so that is the contract locked in here.
    expect(declarations).toMatch(/--bg:\s*#[0-9a-f]{3,8}\s*;/i);
    expect(declarations).toMatch(/--surface:\s*#[0-9a-f]{3,8}\s*;/i);
    expect(declarations).toMatch(/--ink-primary:\s*#[0-9a-f]{3,8}\s*;/i);
    expect(declarations).toMatch(/color-scheme:\s*dark\s*;/);
  });

  it("keeps the light-mode token set in tokens.css", () => {
    expect(tokensCss).toMatch(/--color-surface:\s*#[0-9a-f]{3,8}\s*;/i);
    expect(tokensCss).toMatch(/--color-text:\s*#[0-9a-f]{3,8}\s*;/i);
  });
});

describe("mobile shell and responsive layout", () => {
  it("defines the shell drawer and overlay state selectors", () => {
    expect(appCss).toMatch(/\.app-shell\s*\{/);
    expect(appCss).toMatch(/\.sidebar\.mobile-open\s*\{/);
    expect(appCss).toMatch(/\.mobile-overlay\.show\s*\{/);
  });

  it("keeps dev's 980px drawer and 600px toast media blocks intact", () => {
    const shellBlocks = extractMediaBlocks(appCss, "980px");
    expect(
      shellBlocks.some(
        (block) =>
          block.includes(".sidebar.mobile-open") &&
          block.includes(".mobile-overlay.show"),
      ),
    ).toBe(true);

    const toastBlocks = extractMediaBlocks(appCss, "600px");
    expect(
      toastBlocks.some((block) => block.includes(".toast-stack")),
    ).toBe(true);
  });

  it("ships the 768px kanban/grid block without 100vh regressions", () => {
    const blocks = extractMediaBlocks(appCss, "768px");

    expect(blocks).toHaveLength(1);
    const block = blocks[0];

    expect(block).toContain(".pipeline-board");
    expect(block).toContain(".task-board");
    expect(block).toContain(".pipeline-column");
    expect(block).toContain(".task-column");
    expect(block).toContain(".dashboard-grid");

    // Dynamic viewport units keep mobile browser toolbars from clipping the
    // drawer; a hard-coded 100vh is the regression this guards against.
    expect(block).toMatch(/height:\s*100dvh/);
    expect(block).not.toMatch(/100vh/);
    expect(block).toContain("box-shadow: var(--shadow-lg)");

    // Columns must be free to shrink below 327px without horizontal overflow.
    expect(block).toMatch(/min-width:\s*0/);
    expect(block).toMatch(/flex:\s*0 0 min\(85vw,\s*340px\)/);
  });
});
