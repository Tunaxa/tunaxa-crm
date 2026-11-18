import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailComposerDrawer } from "./EmailComposerDrawer";
import {
  assertEmailResponse,
  canSendEmail,
  deliveryLabel,
  emailPayload,
  fetchInbox,
  type EmailPayload,
  type Message,
} from "./inboxModel";
import { RESOURCE_CHANGED_EVENT, sendRecordEmail } from "./sendRecordEmail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const state = vi.hoisted(() => ({
  role: "admin" as string | undefined,
  sendStatus: "Sent",
  dispatchEvent: vi.fn(),
  api: vi.fn(),
  toast: vi.fn(),
  confirm: vi.fn(),
  onClose: vi.fn(),
  onSent: vi.fn(),
}));

vi.mock("../../context/AppContext", () => ({
  useApp: () => ({
    user: state.role
      ? {
          id: "user-1",
          name: "Test User",
          email: "user@example.com",
          role: state.role,
        }
      : null,
    toast: state.toast,
  }),
}));

vi.mock("../../lib/api", () => ({
  api: (path: string, options?: unknown) => state.api(path, options),
  json: (method: string, body?: unknown) => ({
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  }),
}));

vi.mock("../ui", () => ({
  Drawer: ({
    title,
    subtitle,
    children,
    onClose,
  }: {
    title: string;
    subtitle?: string;
    children: React.ReactNode;
    onClose: () => void;
  }) => (
    <aside
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-subtitle={subtitle}
    >
      <button type="button" aria-label="Close" onClick={onClose}>
        ×
      </button>
      {children}
    </aside>
  ),
}));

class TestCustomEvent {
  readonly type: string;
  readonly detail: unknown;

  constructor(type: string, options?: { detail?: unknown }) {
    this.type = type;
    this.detail = options?.detail;
  }
}

const templates = [
  {
    id: "welcome",
    name: "Welcome",
    subject: "Welcome aboard",
    body: "Welcome body",
  },
];

const mounted: ReactTestRenderer[] = [];

function message(id: string): Message {
  return {
    id,
    channel: "Email",
    to: "customer@example.com",
    from: "",
    replyTo: "",
    subject: `Subject ${id}`,
    body: `Body ${id}`,
    direction: "Outbound",
    status: "Sent",
    read: true,
    createdAt: "2026-11-18T10:00:00Z",
    contact: "Customer Example",
    openedAt: "",
    clickedAt: "",
    deliveredAt: "",
    error: "",
  };
}

function responseFor(payload: EmailPayload, status = state.sendStatus): Message {
  return {
    ...message("message-1"),
    channel: payload.channel,
    to: payload.to,
    subject: payload.subject,
    body: payload.body,
    contact: payload.contact,
    status,
  };
}

function installApiMock(status = state.sendStatus) {
  state.api.mockImplementation(
    async (path: string, options?: { body?: string }) => {
      if (path === "/templates?limit=100") {
        return {
          data: templates,
          total: templates.length,
          page: 1,
          limit: 100,
        };
      }
      if (path === "/messages/send") {
        const payload = JSON.parse(String(options?.body)) as EmailPayload;
        return responseFor(payload, status);
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  );
}

function mountComposer(
  overrides: Partial<React.ComponentProps<typeof EmailComposerDrawer>> = {},
) {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <EmailComposerDrawer
        recipient="customer@example.com"
        contact="Customer Example"
        entity="contact"
        onClose={state.onClose}
        onSent={state.onSent}
        {...overrides}
      />,
    );
  });
  mounted.push(renderer);
  return renderer;
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function inputByType(renderer: ReactTestRenderer, type: string) {
  const input = renderer.root
    .findAll((node) => node.type === "input" && node.props.type === type)
    [0];
  if (!input) throw new Error(`No input[type="${type}"] found`);
  return input;
}

function subjectInput(renderer: ReactTestRenderer) {
  const input = renderer.root
    .findAll((node) => node.type === "input" && node.props.type !== "email")
    [0];
  if (!input) throw new Error("No subject input found");
  return input;
}

function alertText(renderer: ReactTestRenderer) {
  return renderer.root
    .findAll((node) => node.type === "p" && node.props.role === "alert")
    .map((node) => node.children.join(""))
    .join(" ");
}

function statusText(renderer: ReactTestRenderer) {
  return renderer.root
    .findAll((node) => node.type === "p" && node.props.role === "status")
    .map((node) => node.children.join(""))
    .join(" ");
}

function retryButton(renderer: ReactTestRenderer) {
  const button = renderer.root
    .findAll(
      (node) =>
        node.type === "button" &&
        node.children.join("").includes("Retry templates"),
    )[0];
  if (!button) throw new Error("Retry templates button not found");
  return button;
}

beforeEach(() => {
  state.role = "admin";
  state.sendStatus = "Sent";
  state.dispatchEvent.mockReset();
  state.api.mockReset();
  state.toast.mockReset();
  state.confirm.mockReset();
  state.onClose.mockReset();
  state.onSent.mockReset();
  state.confirm.mockReturnValue(true);
  installApiMock();

  vi.stubGlobal("CustomEvent", TestCustomEvent);
  vi.stubGlobal("window", {
    dispatchEvent: state.dispatchEvent,
    confirm: state.confirm,
  });
  vi.stubGlobal("crypto", { randomUUID: () => "test-key" });
});

afterEach(() => {
  while (mounted.length) {
    const renderer = mounted.pop()!;
    act(() => renderer.unmount());
  }
  vi.unstubAllGlobals();
});

describe("inboxModel", () => {
  it("builds a dev-compatible send payload and rejects invalid recipients", () => {
    const payload = emailPayload(
      " Customer <Customer@Example.com> ",
      " Hello ",
      " Hi there ",
      "key-1",
      "Customer Example",
    );

    expect(payload).toEqual({
      channel: "Email",
      to: "customer@example.com",
      subject: "Hello",
      body: "Hi there",
      contact: "Customer Example",
      idempotencyKey: "key-1",
    });
    expect(() => emailPayload("not-an-email", "s", "b", "k")).toThrow(
      "Enter one valid recipient email address",
    );
  });

  it("parses dev's { data, total, page, limit } messages response", async () => {
    const all = Array.from({ length: 51 }, (_, index) =>
      message(`m${index + 1}`),
    );
    const get = vi.fn(async (path: string) => {
      const page = Number(new URLSearchParams(path.split("?")[1]).get("page"));
      const start = (page - 1) * 50;
      return {
        data: all.slice(start, start + 50),
        total: all.length,
        page,
        limit: 50,
      };
    });

    const messages = await fetchInbox(get);

    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[0][0]).toBe("/messages?type=email&page=1&limit=50");
    expect(get.mock.calls[1][0]).toBe("/messages?type=email&page=2&limit=50");
    expect(messages).toHaveLength(51);
    expect(messages[0].id).toBe("m1");
    expect(messages[50].id).toBe("m51");
  });

  it("rejects the old items/hasMore inbox response shape", async () => {
    const get = vi.fn(async () => ({
      items: [message("m1")],
      total: 1,
      page: 1,
      limit: 50,
      hasMore: false,
    }));

    await expect(fetchInbox(get)).rejects.toThrow("Invalid inbox response");
  });

  it("labels all dev send statuses and normalizes role casing", () => {
    expect(deliveryLabel({ ...message("1"), status: "Sent" })).toBe("Email sent");
    expect(deliveryLabel({ ...message("1"), status: "Saved" })).toContain(
      "provider is not configured",
    );
    expect(deliveryLabel({ ...message("1"), status: "Queued" })).toContain(
      "delivery is pending",
    );
    expect(deliveryLabel({ ...message("1"), status: "Failed" })).toContain(
      "delivery failed",
    );

    expect(canSendEmail("Owner")).toBe(true);
    expect(canSendEmail("admin")).toBe(true);
    expect(canSendEmail(" member ")).toBe(true);
    expect(canSendEmail("viewer")).toBe(false);
    expect(canSendEmail("read-only")).toBe(false);
    expect(canSendEmail(undefined)).toBe(false);
  });

  it("asserts send acknowledgement against the dev message shape", () => {
    const payload = emailPayload("customer@example.com", "Hi", "Body", "key-1");
    expect(assertEmailResponse(responseFor(payload, "Queued"), payload).status).toBe(
      "Queued",
    );
    expect(() =>
      assertEmailResponse(responseFor(payload, "Unexpected"), payload),
    ).toThrow("Email result could not be confirmed");
  });
});

describe("sendRecordEmail", () => {
  it("acknowledges success and dispatches tunaxa:resource-changed", async () => {
    const payload = emailPayload("customer@example.com", "Hi", "Body", "key-1");
    const result = await sendRecordEmail(payload, async (sent) =>
      responseFor(sent, "Sent"),
    );

    expect(result.status).toBe("Sent");
    expect(state.dispatchEvent).toHaveBeenCalledTimes(1);
    expect(state.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: RESOURCE_CHANGED_EVENT,
        detail: { resource: "messages" },
      }),
    );
  });

  it("keeps the draft on failure and does not dispatch a refresh", async () => {
    const payload = emailPayload("customer@example.com", "Hi", "Body", "key-1");

    await expect(
      sendRecordEmail(payload, async (sent) => responseFor(sent, "Failed")),
    ).rejects.toThrow("draft is retained");
    expect(state.dispatchEvent).not.toHaveBeenCalled();
  });
});

describe("EmailComposerDrawer", () => {
  it("loads dev's paginated templates, applies one, and has no duplicate heading", async () => {
    installApiMock();
    const renderer = mountComposer();
    await flushEffects();

    expect(
      state.api.mock.calls.some(([path]) => path === "/templates?limit=100"),
    ).toBe(true);
    expect(statusText(renderer)).not.toContain("Templates could not be loaded");

    const dialog = renderer.root.findByProps({ role: "dialog" });
    expect(dialog.props["aria-label"]).toBe("Compose email");
    expect(dialog.props["data-subtitle"]).toContain("Customer Example");
    expect(dialog.props["data-subtitle"]).toContain("contact");
    expect(
      renderer.root.findAll(
        (node) =>
          node.type === "h3" && node.children.join("") === "Compose email",
      ),
    ).toHaveLength(0);
    expect(inputByType(renderer, "email").props.value).toBe(
      "customer@example.com",
    );

    const select = renderer.root.findByType("select");
    act(() => select.props.onChange({ target: { value: "welcome" } }));

    expect(subjectInput(renderer).props.value).toBe("Welcome aboard");
    expect(renderer.root.findByType("textarea").props.value).toBe(
      "Welcome body",
    );
  });

  it("treats an empty dev template page as an empty state", async () => {
    state.api.mockImplementation(async (path: string) => {
      if (path === "/templates?limit=100") {
        return { data: [], total: 0, page: 1, limit: 100 };
      }
      throw new Error(`Unexpected API path: ${path}`);
    });

    const renderer = mountComposer();
    await flushEffects();

    expect(statusText(renderer)).toContain("No templates available");
    expect(statusText(renderer)).not.toContain("Templates could not be loaded");
    expect(renderer.root.findByType("select").props.disabled).toBe(true);
  });

  it("recovers from a template load error via the Retry templates button", async () => {
    let templateCalls = 0;
    state.api.mockImplementation(
      async (path: string, options?: { body?: string }) => {
        if (path === "/templates?limit=100") {
          templateCalls += 1;
          if (templateCalls === 1) throw new Error("network down");
          return {
            data: templates,
            total: templates.length,
            page: 1,
            limit: 100,
          };
        }
        if (path === "/messages/send") {
          const payload = JSON.parse(String(options?.body)) as EmailPayload;
          return responseFor(payload, state.sendStatus);
        }
        throw new Error(`Unexpected API path: ${path}`);
      },
    );

    const renderer = mountComposer();
    await flushEffects();

    expect(statusText(renderer)).toContain("Templates could not be loaded");
    const retry = retryButton(renderer);
    expect(retry.props.type).toBe("button");

    await act(async () => {
      retry.props.onClick();
    });
    await flushEffects();

    expect(templateCalls).toBe(2);
    expect(statusText(renderer)).not.toContain("Templates could not be loaded");
    expect(
      state.api.mock.calls.some(([path]) => path === "/messages/send"),
    ).toBe(false);

    const select = renderer.root.findByType("select");
    act(() => select.props.onChange({ target: { value: "welcome" } }));
    expect(renderer.root.findByType("textarea").props.value).toBe(
      "Welcome body",
    );
  });

  it("shows a role=alert validation message without calling send", async () => {
    installApiMock();
    const renderer = mountComposer();
    await flushEffects();

    const form = renderer.root.findByType("form");
    await act(async () => {
      await form.props.onSubmit({ preventDefault: () => {} });
    });

    expect(alertText(renderer)).toContain("Write a message before sending");
    expect(
      state.api.mock.calls.some(([path]) => path === "/messages/send"),
    ).toBe(false);
  });

  it("confirms before discarding an unsaved draft", async () => {
    installApiMock();
    const renderer = mountComposer();
    await flushEffects();

    const draftRegion = renderer.root
      .findAll((node) => node.type === "div" && "onChangeCapture" in node.props)
      [0];
    if (!draftRegion) throw new Error("Draft region not found");
    act(() => draftRegion.props.onChangeCapture());

    state.confirm.mockReturnValue(false);
    act(() => renderer.root.findByProps({ "aria-label": "Close" }).props.onClick());
    expect(state.onClose).not.toHaveBeenCalled();

    state.confirm.mockReturnValue(true);
    act(() => renderer.root.findByProps({ "aria-label": "Close" }).props.onClick());
    expect(state.onClose).toHaveBeenCalledTimes(1);
  });

  it("submits, acknowledges, refreshes, and closes on success", async () => {
    installApiMock("Sent");
    const renderer = mountComposer();
    await flushEffects();

    const textarea = renderer.root.findByType("textarea");
    act(() =>
      textarea.props.onChange({ target: { value: "Plain text body" } }),
    );

    const form = renderer.root.findByType("form");
    await act(async () => {
      await form.props.onSubmit({ preventDefault: () => {} });
    });

    expect(
      state.api.mock.calls.some(([path]) => path === "/messages/send"),
    ).toBe(true);
    expect(state.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: RESOURCE_CHANGED_EVENT }),
    );
    expect(state.toast).toHaveBeenCalledWith("Email sent");
    expect(state.onSent).toHaveBeenCalledWith(
      expect.objectContaining({ status: "Sent" }),
    );
    expect(state.onClose).toHaveBeenCalledTimes(1);
  });

  it("retains the draft and reports failures", async () => {
    installApiMock("Failed");
    const renderer = mountComposer();
    await flushEffects();

    const textarea = renderer.root.findByType("textarea");
    act(() => textarea.props.onChange({ target: { value: "Keep this draft" } }));

    const form = renderer.root.findByType("form");
    await act(async () => {
      await form.props.onSubmit({ preventDefault: () => {} });
    });

    expect(alertText(renderer)).toContain("draft is retained");
    expect(renderer.root.findByType("textarea").props.value).toBe(
      "Keep this draft",
    );
    expect(state.onClose).not.toHaveBeenCalled();
  });
});
