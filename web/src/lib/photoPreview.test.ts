import { describe, expect, it } from "vitest";
import { photoInitials, photoPreviewUrl } from "./photoPreview";

describe("photo preview safety", () => {
  it("rejects executable, HTML and SVG sources", () => {
    for (const value of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "data:image/svg+xml,<svg onload='alert(1)'/>", "//evil.example/photo.png", "/uploads/../index.html"]) {
      expect(photoPreviewUrl(value)).toBeUndefined();
    }
  });
  it("preserves supported image sources", () => {
    for (const value of ["/uploads/photo.png", "/assets/logo.png", "https://example.com/photo.png", "data:image/png;base64,YQ=="]) {
      expect(photoPreviewUrl(value)).toBe(value);
    }
  });
  it("keeps initials as letters and numbers", () => {
    expect(photoInitials("Alice Brown")).toBe("AB");
    expect(photoInitials("< >")).toBe("NX");
    expect(photoInitials("Élodie Ben")).toBe("ÉB");
  });
});
