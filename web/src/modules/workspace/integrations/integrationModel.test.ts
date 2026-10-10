import { describe, expect, it } from "vitest";
import { assertSlackSaved, canManageIntegrations, integrationError, parseIntegrations, slackPayload } from "./integrationModel";

const url = "https://hooks.slack.com/services/T000/B000/dummySecret123456";
const config = { slack: { configured: true, webhookUrlMasked: "https://hooks.slack.com/••••••123456" }, zapier: { configured: false, webhookUrlMasked: "" } };

describe("integration configuration contract", () => {
  it.each(["admin", "Owner", "owner"])("allows backend administrator role %s", role => expect(canManageIntegrations(role)).toBe(true));
  it.each(["member", "viewer", "Manager", undefined])("keeps role %s read only", role => expect(canManageIntegrations(role)).toBe(false));
  it("trims a Slack URL and uses the exact backend write field", () => expect(slackPayload(`  ${url}  `)).toEqual({ slackWebhookUrl: url }));
  it("accepts GovSlack's incoming webhook domain", () => expect(slackPayload(url.replace("slack.com", "slack-gov.com")).slackWebhookUrl).toContain("hooks.slack-gov.com"));
  it.each(["", "not a URL", url.replace("https:", "http:"), url.replace("hooks.slack.com", "hooks.slack.com.evil.test"), url.replace("hooks.slack.com", "example.com"), url.replace("https://", "https://user:password@"), url.replace("hooks.slack.com", "hooks.slack.com:444"), `${url}?token=secret`, `${url}#secret`, `${url}/`, "https://hooks.slack.com/services/only-one", config.slack.webhookUrlMasked])("rejects invalid webhook input without exposing it", value => {
    let error = "";
    try { slackPayload(value); } catch (failure) { error = (failure as Error).message; }
    expect(error).toBeTruthy();
    expect(error).not.toContain("dummySecret");
    expect(error).not.toContain("user:password");
  });
  it("retains only masked response fields", () => {
    const parsed = parseIntegrations({ ...config, slack: { ...config.slack, webhookUrl: url }, token: "private" });
    expect(parsed).toEqual(config);
    expect(JSON.stringify(parsed)).not.toContain("dummySecret");
  });
  it.each([{}, null, { ...config, slack: { configured: true, webhookUrlMasked: url } }, { ...config, slack: { configured: false, webhookUrlMasked: config.slack.webhookUrlMasked } }, { ...config, zapier: { configured: "true", webhookUrlMasked: "" } }])("fails closed for malformed or unmasked responses", value => expect(() => parseIntegrations(value)).toThrow("Invalid integration configuration response"));
  it("checks masked acknowledgement against the submitted webhook", () => expect(assertSlackSaved(config, slackPayload(url))).toEqual(config));
  it("rejects acknowledgement for another webhook", () => expect(() => assertSlackSaved(config, slackPayload(url.replace("123456", "654321")))).toThrow("could not be confirmed"));
  it("does not interpret an unconfigured response as a successful connection", () => expect(() => assertSlackSaved({ ...config, slack: { configured: false, webhookUrlMasked: "" } }, slackPayload(url))).toThrow());
  it.each([400, 401, 403, 404, 500, undefined])("redacts server errors with status %s", status => {
    for (const operation of ["load", "save"] as const) expect(integrationError({ status, message: url }, operation)).not.toContain(url);
  });
  it("explains that the pending API is unavailable", () => expect(integrationError({ status: 404 }, "load")).toContain("not available on this server yet"));
});
