import { describe, expect, it, vi } from "vitest";
import {
  allowedByRole,
  isModuleVisible,
  moduleBasePath,
  modulePathFromHash,
  modulePathsFromPayload,
  normalizeRole,
} from "./moduleVisibility";
import { buildFormPayload, normalizeFormFields } from "./marketing/FormsPage";
import {
  moveDealToStage,
  pipelineMoveMessage,
} from "./sales/pipelineActions";

describe("module visibility and deep links", () => {
  it("derives catalog paths from hash routes and parameterised detail routes", () => {
    expect(modulePathFromHash("#/leads?utm=1")).toBe("/leads");
    expect(modulePathFromHash("#/contacts/abc-123")).toBe("/contacts/abc-123");
    expect(moduleBasePath("/leads/abc-123")).toBe("/leads");
    expect(moduleBasePath("/design-system")).toBe("/design-system");
  });

  it("parses the /api/modules payload defensively", () => {
    const paths = modulePathsFromPayload({
      modules: [
        { id: "dashboard", path: "/" },
        { id: "contacts", path: "/contacts/" },
        { path: 42 },
        null,
      ],
    });
    expect(paths?.has("/")).toBe(true);
    expect(paths?.has("/contacts")).toBe(true);
    expect(paths?.has("/42")).toBe(false);
    expect(modulePathsFromPayload({ modules: "invalid" })).toBeNull();
  });

  it("denies catalog paths hidden by the API even for admins", () => {
    const visible = new Set(["/", "/contacts", "/companies"]);
    expect(isModuleVisible("/leads", visible, "admin")).toBe(false);
    expect(isModuleVisible("/leads/42", visible, "admin")).toBe(false);
    expect(isModuleVisible("/contacts", visible, "viewer")).toBe(true);
  });

  it("gates /tickets through the API module catalog and role fallback", () => {
    expect(isModuleVisible("/tickets", new Set(["/", "/tickets"]), "viewer")).toBe(true);
    expect(isModuleVisible("/tickets", new Set(["/", "/contacts"]), "admin")).toBe(false);
    expect(isModuleVisible("/tickets/42", new Set(["/", "/tickets"]), "viewer")).toBe(true);
    expect(isModuleVisible("/tickets", null, "viewer")).toBe(true);
    expect(allowedByRole("/tickets", "viewer")).toBe(true);
  });

  it("allows unlisted legacy marketing paths and falls back to role rank", () => {
    expect(isModuleVisible("/campaigns", new Set(), "viewer")).toBe(true);
    expect(isModuleVisible("/forms", new Set(), "viewer")).toBe(true);
    expect(allowedByRole("/leads", "viewer")).toBe(false);
    expect(allowedByRole("/leads", "member")).toBe(true);
    expect(allowedByRole("/settings", "admin")).toBe(true);
    expect(normalizeRole("Owner")).toBe("owner");
  });
});

describe("marketing form hardening", () => {
  it("drops duplicate and prototype-polluting field keys", () => {
    const fields = normalizeFormFields([
      { key: "email", name: "Email", type: "email", required: true },
      { key: "email", name: "Duplicate" },
      { key: "__proto__", name: "Blocked" },
      { key: "message", type: "unsupported" },
    ]);
    expect(fields).toEqual([
      { key: "email", name: "Email", type: "email", required: true },
      { key: "message", name: "message", type: "text", required: false },
    ]);
  });

  it("builds a safe payload and rejects unsafe redirects", () => {
    const payload = buildFormPayload({
      name: "Contact us",
      title: "Contact us",
      description: "Questions",
      submitTo: "anything",
      progressive: true,
      redirectUrl: "/thanks",
      enabled: true,
      fields: [{ key: "email", name: "Email", type: "email", required: true }],
    });
    expect(payload.submitTo).toBe("lead");
    expect(payload.redirectUrl).toBe("/thanks");
    expect(payload.fields[0].key).toBe("email");

    expect(() =>
      buildFormPayload({
        name: "Unsafe",
        title: "",
        description: "",
        submitTo: "lead",
        progressive: false,
        redirectUrl: "javascript:alert(1)",
        enabled: true,
        fields: [{ key: "email", name: "Email", type: "email", required: false }],
      }),
    ).toThrow(/Redirect URL/);
  });
});

describe("pipeline move handling", () => {
  it("reports a useful message when a stage update fails", async () => {
    const reportError = vi.fn();
    const ok = await moveDealToStage(
      vi.fn().mockRejectedValue(new Error("Stage lock")),
      "deal-1",
      "won",
      reportError,
    );
    expect(ok).toBe(false);
    expect(reportError).toHaveBeenCalledWith("Stage lock");
    expect(pipelineMoveMessage(new Error(""))).toBe("Could not move this deal. Please try again.");
  });

  it("returns success without reporting an error", async () => {
    const update = vi.fn().mockResolvedValue({ id: "deal-1" });
    const reportError = vi.fn();
    await expect(moveDealToStage(update, "deal-1", "qualified", reportError)).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith("deal-1", { stage: "qualified" });
    expect(reportError).not.toHaveBeenCalled();
  });
});
