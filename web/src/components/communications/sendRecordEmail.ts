import {
  assertEmailResponse,
  inboxError,
  recordEmailActivity,
  withRecordLinkage,
  type EmailActivity,
  type EmailPayload,
  type Message,
  type RecordEmailContext,
} from "./inboxModel";

export const RESOURCE_CHANGED_EVENT = "tunaxa:resource-changed";

type SendOptions = {
  record?: RecordEmailContext;
  logActivity?: (activity: EmailActivity) => Promise<unknown>;
};

function dispatchResourceChanged(resource: string) {
  if (typeof window === "undefined" || typeof CustomEvent !== "function") return;
  window.dispatchEvent(
    new CustomEvent(RESOURCE_CHANGED_EVENT, {
      detail: { resource },
    }),
  );
}

/**
 * Sends a message and, for record-level composer usage, persists a linked
 * activity so the email appears in the Contact/Lead Activity timeline. Both
 * refresh events are dispatched after the send and activity write finish.
 */
export async function sendRecordEmail(
  payload: EmailPayload,
  request: (payload: EmailPayload) => Promise<unknown>,
  options: SendOptions = {},
): Promise<Message> {
  let message: Message;
  const linkedPayload = options.record
    ? withRecordLinkage(payload, options.record)
    : payload;

  try {
    message = assertEmailResponse(await request(linkedPayload), linkedPayload);
  } catch (failure) {
    throw new Error(
      inboxError(
        failure,
        "Send could not be confirmed. Check the inbox before retrying; your draft is retained.",
      ),
    );
  }

  if (message.status === "Failed") {
    throw new Error(
      "Email delivery failed. Your draft is retained; check the provider settings before retrying.",
    );
  }

  let activityFailed = false;
  if (options.record && options.logActivity) {
    try {
      await options.logActivity(
        recordEmailActivity(message, options.record, payload.contact),
      );
    } catch {
      activityFailed = true;
    }
  }

  dispatchResourceChanged("messages");
  dispatchResourceChanged("activities");

  if (activityFailed) {
    throw new Error(
      "Email sent, but it could not be added to this record's timeline. Refresh before retrying; your draft is retained.",
    );
  }
  return message;
}
