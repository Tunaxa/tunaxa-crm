import { describe, expect, it } from "vitest";
import {
  createTypedSignatureDataUrl,
  isSignatureReady,
} from "./signatureUtils";

describe("signature validation", () => {
  it("requires consent and a drawing in draw mode", () => {
    expect(
      isSignatureReady({
        mode: "draw",
        typedName: "",
        hasDrawing: true,
        agreed: false,
      }),
    ).toBe(false);
    expect(
      isSignatureReady({
        mode: "draw",
        typedName: "",
        hasDrawing: true,
        agreed: true,
      }),
    ).toBe(true);
  });

  it("requires consent and a non-empty typed name in type mode", () => {
    expect(
      isSignatureReady({
        mode: "type",
        typedName: "   ",
        hasDrawing: false,
        agreed: true,
      }),
    ).toBe(false);
    expect(
      isSignatureReady({
        mode: "type",
        typedName: "Ada Lovelace",
        hasDrawing: false,
        agreed: true,
      }),
    ).toBe(true);
  });
});

describe("typed signature image", () => {
  it("creates an SVG image data URL", () => {
    const result = createTypedSignatureDataUrl("Ada Lovelace");
    expect(result).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(decodeURIComponent(result)).toContain("Ada Lovelace");
  });

  it("escapes markup from the typed name", () => {
    const result = decodeURIComponent(
      createTypedSignatureDataUrl('<script>alert("x")</script>'),
    );
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
    expect(result).toContain("&quot;x&quot;");
  });
});
