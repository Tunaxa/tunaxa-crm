import {
  assertEmailResponse,
  inboxError,
  type EmailPayload,
  type Message,
} from "./inboxModel";

export const RESOURCE_CHANGED_EVENT = "tunaxa:resource-changed";

export async function sendRecordEmail(
  payload: EmailPayload,
  request: (payload: EmailPayload) => Promise<unknown>,
): Promise<Message> {
  try {
    const message = assertEmailResponse(await request(payload), payload);
    if (message.status === "Failed") {
      throw new Error(
        "Email delivery failed. Your draft is retained; check the provider settings before retrying.",
      );
    }
    if (typeof window !== "undefined" && typeof CustomEvent === "function") {
      window.dispatchEvent(
        new CustomEvent(RESOURCE_CHANGED_EVENT, {
          detail: { resource: "messages" },
        }),
      );
    }
    return message;
  } catch (failure) {
    if (
      failure instanceof Error &&
      failure.message.startsWith("Email delivery failed.")
    ) {
      throw failure;
    }
    throw new Error(
      inboxError(
        failure,
        "Send could not be confirmed. Check the inbox before retrying; your draft is retained.",
      ),
    );
  }
}
