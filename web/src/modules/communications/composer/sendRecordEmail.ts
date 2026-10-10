import { assertEmailResponse, inboxError, type EmailPayload } from "../inbox/inboxModel";

export async function sendRecordEmail(payload: EmailPayload, request: (payload: EmailPayload) => Promise<unknown>) {
  try {
    const message = assertEmailResponse(await request(payload), payload);
    if (message.status === "Failed") throw new Error("Email delivery failed. Your draft is retained; check the provider settings before retrying.");
    return message;
  } catch (failure) {
    if (failure instanceof Error && failure.message.startsWith("Email delivery failed.")) throw failure;
    throw new Error(inboxError(failure, "Send could not be confirmed. Check the inbox before retrying; your draft is retained."));
  }
}
