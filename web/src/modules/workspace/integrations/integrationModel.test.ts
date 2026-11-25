import { describe, expect, it } from "vitest";
import {
  assertSlackDisconnected,
  assertSlackSaved,
  canManageIntegrations,
  integrationError,
  parseIntegrations,
  parseSlackTest,
  slackPayload,
} from "./integrationModel";

const url = "https://hooks.slack.com/services/T000/B000/dummySecret123456";
const config = {
  slack: { configured: true, webhookUrlMasked: "https://hooks.slack.com/••••••123456" },
  zapier: { configured: false, webhookUrlMasked: "" },
};

describe("integration configuration contract", () => {
  it.each(["admin", "Owner", "owner"])("allows backend administrator role %s", (role) =>
    expect(canManageIntegrations(role)).toBe(true),
  );

  it.each(["member", "viewer", "Manager", undefined])("keeps role %s read only", (role) =>
    expect(canManageIntegrations(role)).toBe(false),
  );

  it("trims a Slack URL and uses the exact backend write field", () =>
    expect(slackPayload(`  ${url}  `)).toEqual({ slackWebhookUrl: url }));

  it("rejects GovSlack and every other non-standard host", () => {
    expect(() => slackPayload(url.replace("slack.com", "slack-gov.com"))).toThrow();
    expect(() => slackPayload(url.replace("slack.com", "hooks.slack.com.evil.test"))).toThrow();
  });

  it.each([
    "",
    "not a URL",
    url.replace("https:", "http:"),
    url.replace("hooks.slack.com", "example.com"),
    url.replace("https://", "https://user:password@"),
    url.replace("hooks.slack.com", "hooks.slack.com:444"),
    `${url}?token=secret`,
    `${url}#secret`,
    `${url}/`,
    "https://hooks.slack.com/services/only-one",
    config.slack.webhookUrlMasked,
  ])("rejects invalid webhook input without exposing it", (value) => {
    let error = "";
    try {
      slackPayload(value);
    } catch (failure) {
      error = (failure as Error).message;
    }
    expect(error).toBeTruthy();
    expect(error).not.toContain("dummySecret");
    expect(error).not.toContain("user:password");
  });

  it("retains only masked response fields", () => {
    const parsed = parseIntegrations({
      ...config,
      slack: { ...config.slack, webhookUrl: url },
      token: "private",
    });
    expect(parsed).toEqual(config);
    expect(JSON.stringify(parsed)).not.toContain("dummySecret");
  });

  it.each([
    {},
    null,
    { ...config, slack: { configured: true, webhookUrlMasked: url } },
    { ...config, slack: { configured: false, webhookUrlMasked: config.slack.webhookUrlMasked } },
    { ...config, zapier: { configured: "true", webhookUrlMasked: "" } },
    JSON.parse(`{"slack":{"configured":true,"webhookUrlMasked":"${config.slack.webhookUrlMasked}"},"zapier":{"configured":false,"webhookUrlMasked":""},"__proto__":{"polluted":true}}`),
  ])("fails closed for malformed, unmasked or unsafe responses", (value) =>
    expect(() => parseIntegrations(value)).toThrow("Invalid integration configuration response"),
  );

  it("does not pollute prototypes through nested configuration keys", () => {
    const value = JSON.parse(
      `{"slack":{"configured":true,"webhookUrlMasked":"${config.slack.webhookUrlMasked}","__proto__":{"polluted":true}},"zapier":{"configured":false,"webhookUrlMasked":""}}`,
    );
    expect(() => parseIntegrations(value)).toThrow("Invalid integration configuration response");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("checks masked acknowledgement against the submitted webhook", () =>
    expect(assertSlackSaved(config, slackPayload(url))).toEqual(config));

  it("rejects acknowledgement for another webhook", () =>
    expect(() => assertSlackSaved(config, slackPayload(url.replace("123456", "654321")))).toThrow(
      "could not be confirmed",
    ));

  it("does not interpret an unconfigured response as a successful connection", () =>
    expect(() =>
      assertSlackSaved({ ...config, slack: { configured: false, webhookUrlMasked: "" } }, slackPayload(url)),
    ).toThrow());

  it("confirms a cleared Slack configuration", () =>
    expect(
      assertSlackDisconnected({ ...config, slack: { configured: false, webhookUrlMasked: "" } }),
    ).toEqual({ ...config, slack: { configured: false, webhookUrlMasked: "" } }));

  it("rejects a disconnect response that still claims configuration", () =>
    expect(() => assertSlackDisconnected(config)).toThrow("could not be confirmed"));

  it("parses a safe test result", () =>
    expect(
      parseSlackTest({
        success: true,
        configured: true,
        provider: "slack",
        message: "Slack webhook responded successfully.",
        webhookUrl: url,
      }),
    ).toEqual({
      success: true,
      configured: true,
      provider: "slack",
      message: "Slack webhook responded successfully.",
    }));

  it.each([{}, null, { success: "true", configured: true, provider: "slack" }])(
    "fails closed for malformed test responses",
    (value) => expect(() => parseSlackTest(value)).toThrow("Slack test response was invalid"),
  );

  it.each([400, 401, 403, 404, 500, 502, undefined])(
    "redacts server errors with status %s",
    (status) => {
      for (const operation of ["load", "save", "disconnect", "test"] as const) {
        expect(integrationError({ status, message: url }, operation)).not.toContain(url);
      }
    },
  );

  it("reports a failed connection check without server text", () =>
    expect(integrationError({ status: 502, message: url }, "test")).toContain(
      "did not respond successfully",
    ));
});
