import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ContractDetails, contractSignature, contractSummaryValue, signatureImageSource } from "./ContractDetails";
import { createTypedSignatureDataUrl } from "../signatures/signatureUtils";

describe("contract details", () => {
  it("preserves zero amounts and false renewal values while rejecting malformed values", () => {
    expect(contractSummaryValue(0, "number", "value")).toContain("0");
    expect(contractSummaryValue(false, "checkbox")).toBe("No");
    expect(contractSummaryValue(true, "checkbox")).toBe("Yes");
    expect(contractSummaryValue("invalid", "number", "mrr")).toBe("Unavailable");
    expect(contractSummaryValue({}, "text")).toBe("Unavailable");
    expect(contractSummaryValue(null, "checkbox")).toBe("Unavailable");
  });
  it("shows unavailable metadata without inventing a signer or quote link", () => {
    const html = renderToStaticMarkup(<MemoryRouter><ContractDetails record={{}} /></MemoryRouter>);
    expect(html).toContain("No original quote reference available");
    expect(html).toContain("Signer IP address");
    expect(html).toContain("Signature image unavailable");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("href=");
  });

  it("links to the quote id and displays stored signature metadata", () => {
    const image = createTypedSignatureDataUrl("Alice");
    const html = renderToStaticMarkup(<MemoryRouter><ContractDetails record={{
      quoteId: "quote/1", quoteNumber: "Q-1", signature: { signerName: "Alice",
        signerEmail: "alice@example.com", signerIp: "192.0.2.1",
        signedAt: "2026-09-27T10:00:00Z", imageDataUrl: image },
    }} /></MemoryRouter>);
    expect(html).toContain('/quotes/quote%2F1');
    expect(html).toContain("Q-1");
    expect(html).toContain("alice@example.com");
    expect(html).toContain("192.0.2.1");
    expect(html).toContain('alt="Recorded contract signature"');
  });

  it("supports the signature modal payload and safely handles malformed metadata", () => {
    expect(contractSignature({ signature: { typedName: "Alice", signedAt: "bad date",
      signerIp: {}, signerEmail: [], imageDataUrl: "javascript:alert(1)" } }))
      .toMatchObject({ name: "Alice", timestamp: "", ip: "", email: "", image: "" });
    expect(contractSignature({ signature: null }).name).toBe("");
    expect(contractSignature({ signature: [] }).name).toBe("");
  });

  it.each(["javascript:alert(1)", "data:text/html,<script></script>", "//example.com/a.png", {}, null])(
    "rejects non-image or unsupported sources (%s)", (source) => {
      expect(signatureImageSource(source)).toBe("");
    },
  );
  it("supports drawn PNG images and local uploaded images", () => {
    expect(signatureImageSource("data:image/png;base64,YWJj")).toBe("data:image/png;base64,YWJj");
    expect(signatureImageSource("/uploads/signature.png")).toBe("/uploads/signature.png");
  });
});
