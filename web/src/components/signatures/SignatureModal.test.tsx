import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SignatureModal } from "./SignatureModal";

describe("SignatureModal", () => {
  it("renders both signing methods, consent, and a guarded submit action", () => {
    const markup = renderToStaticMarkup(
      <SignatureModal onClose={() => {}} onSubmit={() => {}} />,
    );

    expect(markup).toContain("Draw signature");
    expect(markup).toContain("Type your name");
    expect(markup).toContain("I agree to sign this document electronically");
    expect(markup).toContain("Submit Signature");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Submit Signature<\/button>/);
    expect(markup).toContain('aria-label="Draw your signature"');
  });
});
