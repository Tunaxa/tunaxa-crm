import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SectionHeader } from "../components/ui/SectionHeader";
import { Badge } from "../components/ui/Badge";

/**
 * SectionHeader and Badge are shared design-system primitives consumed by the
 * CRM pages. These tests lock down their rendering contracts: the heading level
 * must be selectable (record detail pages need `h1`, section headers keep `h2`)
 * and the heading colour must come from the design token, never a hardcoded
 * hex pair that would ignore the dark theme.
 */
describe("SectionHeader", () => {
  it("renders an h2 by default", () => {
    const html = renderToStaticMarkup(<SectionHeader title="Active Leads" />);

    expect(html).toContain("<h2");
    expect(html).not.toContain("<h1");
    expect(html).toContain("Active Leads");
  });

  it("renders the badge, meta and action slots when provided", () => {
    const html = renderToStaticMarkup(
      <SectionHeader
        badge="/ 01 SALES"
        title="Active Leads"
        meta="47 RECORDS"
        action={<button type="button">New lead</button>}
      />,
    );

    expect(html).toContain("/ 01 SALES");
    expect(html).toContain("47 RECORDS");
    expect(html).toContain("<button");
    expect(html).toContain("New lead");
  });

  it("omits the optional slots when they are not provided", () => {
    const html = renderToStaticMarkup(<SectionHeader title="Bare header" />);

    expect(html).not.toContain("<button");
    expect(html).not.toContain("47 RECORDS");
  });

  it('renders an h1 when as="h1" so record detail pages keep a page-level heading', () => {
    const html = renderToStaticMarkup(
      <SectionHeader as="h1" title="Jane Doe" />,
    );

    expect(html).toContain("<h1");
    expect(html).not.toContain("<h2");
    expect(html).toContain("Jane Doe");
  });

  it('renders an h3 when as="h3" for nested sections', () => {
    const html = renderToStaticMarkup(
      <SectionHeader as="h3" title="Nested" />,
    );

    expect(html).toContain("<h3");
    expect(html).not.toContain("<h1");
    expect(html).not.toContain("<h2");
  });

  it("colours the heading with the ink-primary design token", () => {
    const html = renderToStaticMarkup(<SectionHeader title="Tokenised" />);

    expect(html).toContain("text-[var(--ink-primary)]");
    // The old hardcoded light/dark hex pair bypassed the token system.
    expect(html).not.toContain("#000000");
    expect(html).not.toContain("#f8fafc");
  });

  it("passes a custom className through to the wrapper", () => {
    const html = renderToStaticMarkup(
      <SectionHeader title="Custom" className="my-custom-header" />,
    );

    expect(html).toContain("my-custom-header");
  });
});

describe("Badge", () => {
  const TONES = ["neutral", "blue", "green", "amber", "red", "purple"] as const;
  const VARIANTS = ["blue", "emerald", "amber", "red", "neutral"] as const;

  it.each(TONES)("renders its children for tone=%s", (tone) => {
    const html = renderToStaticMarkup(
      <Badge tone={tone}>{`tone-${tone}`}</Badge>,
    );

    expect(html).toContain("<span");
    expect(html).toContain(`tone-${tone}`);
  });

  it.each(VARIANTS)("renders its children for variant=%s", (variant) => {
    const html = renderToStaticMarkup(
      <Badge variant={variant}>{`variant-${variant}`}</Badge>,
    );

    expect(html).toContain("<span");
    expect(html).toContain(`variant-${variant}`);
  });

  it("maps the legacy green tone onto the emerald palette", () => {
    const html = renderToStaticMarkup(<Badge tone="green">82</Badge>);

    expect(html).toContain("emerald");
    expect(html).toContain("82");
  });

  it("maps the legacy purple tone onto the blue palette", () => {
    const html = renderToStaticMarkup(<Badge tone="purple">82</Badge>);

    expect(html).toContain("#3b82f6");
  });

  it("prefers an explicit variant over the legacy tone", () => {
    const html = renderToStaticMarkup(
      <Badge tone="red" variant="emerald">
        82
      </Badge>,
    );

    expect(html).toContain("emerald");
    expect(html).not.toContain("red-500");
  });

  it("passes a custom className through to the badge element", () => {
    const html = renderToStaticMarkup(
      <Badge className="my-custom-badge">1</Badge>,
    );

    expect(html).toContain("my-custom-badge");
  });
});
