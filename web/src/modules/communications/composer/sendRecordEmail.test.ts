import { describe, expect, it, vi } from "vitest";
import { emailPayload } from "../inbox/inboxModel";
import { sendRecordEmail } from "./sendRecordEmail";

const payload = emailPayload("customer@example.com", "Proposal", "Hello", "email_attempt", "Customer");
const response = (status: string) => ({ ...payload, id: "message_1", status });
describe("record email submission", () => {
  it.each(["Sent", "Saved", "Queued"])("accepts a confirmed %s outcome without inventing delivery", async status => {
    const request = vi.fn().mockResolvedValue(response(status));
    expect((await sendRecordEmail(payload, request)).status).toBe(status);
    expect(request).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledWith(payload);
  });
  it("keeps failed delivery as a retryable draft error", async () => {
    await expect(sendRecordEmail(payload, async () => response("Failed"))).rejects.toThrow("Your draft is retained");
  });
  it("does not accept a response for a different recipient", async () => {
    await expect(sendRecordEmail(payload, async () => ({ ...response("Sent"), to: "other@example.com" }))).rejects.toThrow("Send could not be confirmed");
  });
  it("does not claim success after an uncertain network failure", async () => {
    await expect(sendRecordEmail(payload, async () => { throw new Error("network"); })).rejects.toThrow("Check the inbox before retrying");
  });
  it("explains permission failures", async () => {
    await expect(sendRecordEmail(payload, async () => { throw { status: 403 }; })).rejects.toThrow("permission");
  });
});
