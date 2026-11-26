import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../context/AppContext";
import { ActionConfigPanel } from "./ActionConfigPanel";
import {
  EmailTemplatePreview,
  EmailTemplateSelector,
} from "./EmailTemplateSelector";
import WorkflowCanvas, { canConfigureTemplates } from "./WorkflowCanvas";
import { WorkflowDetailPage } from "./WorkflowDetailPage";
import {
  isSendEmail,
  parseEmailTemplates,
  templateConfiguration,
  templateParts,
} from "./emailTemplates";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const state = vi.hoisted(() => ({
  api: vi.fn(),
  onClose: vi.fn(),
  onSelect: vi.fn(),
  role: undefined as string | undefined,
}));

vi.mock("../../lib/api", () => ({
  api: (path: string, options?: unknown) => state.api(path, options),
  json: (method: string, body?: unknown) => ({
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  }),
  getToken: () => "",
  setToken: () => {},
  registerLogoutHandler: () => () => {},
}));

vi.mock("@xyflow/react", () => ({
  Background: () => <div className="react-flow__background" />,
  Controls: () => <div className="react-flow__controls" />,
  MiniMap: () => <div className="react-flow__minimap" />,
  ReactFlow: ({
    children,
    nodes,
    onNodeClick,
    onPaneClick,
  }: {
    children: React.ReactNode;
    nodes: unknown[];
    onNodeClick?: (event: unknown, node: unknown) => void;
    onPaneClick?: () => void;
  }) => (
    <div className="react-flow">
      {nodes.map((node, index) => (
        <button
          type="button"
          key={index}
          className="workflow-node"
          onClick={(event) => onNodeClick?.(event, node)}
        />
      ))}
      <button
        type="button"
        className="react-flow__pane"
        onClick={onPaneClick}
      />
      {children}
    </div>
  ),
  addEdge: (connection: unknown, edges: unknown[]) => [...edges, connection],
  applyNodeChanges: (_changes: unknown[], nodes: unknown[]) => nodes,
  applyEdgeChanges: (_changes: unknown[], edges: unknown[]) => edges,
}));

vi.mock("../../context/AppContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../context/AppContext")>();
  return {
    ...actual,
    useApp: () => ({
      user: state.role
        ? {
            id: "usr_1",
            name: "Test User",
            email: "test@example.com",
            role: state.role,
          }
        : null,
      setUser: () => {},
      toast: () => {},
      logout: async () => {},
    }),
  };
});

vi.mock("react-router-dom", () => ({
  Link: ({
    children,
    to,
    className,
  }: {
    children: React.ReactNode;
    to: string;
    className?: string;
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useParams: () => ({ id: "w1" }),
  useNavigate: () => () => {},
  useLocation: () => ({
    pathname: "/workflows/w1",
    search: "",
    hash: "#/workflows/w1",
  }),
}));

const template = {
  id: "tpl_1",
  name: "Welcome",
  subject: "Hello {{name}}",
  body: "Hi {{ contact.name }}\nVisit {{website}}",
};

type KeyHandler = (event: KeyboardEvent) => void;

const globals = globalThis as unknown as Record<string, unknown>;
let originalWindow: unknown;
let originalDocument: unknown;
let windowHandlers: Set<KeyHandler>;
let documentHandlers: Set<KeyHandler>;
let classListValues: Set<string>;
let focusCalls: number;
let fakeContainer: {
  focus: () => void;
  querySelectorAll: () => unknown[];
  querySelector: () => null;
  contains: () => boolean;
};

function installDom() {
  originalWindow = globals.window;
  originalDocument = globals.document;
  windowHandlers = new Set();
  documentHandlers = new Set();
  classListValues = new Set();
  focusCalls = 0;
  fakeContainer = {
    focus: () => {
      focusCalls += 1;
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    contains: () => false,
  };
  const activeElement = {
    focus: () => {
      focusCalls += 1;
    },
  };
  const body = {
    classList: {
      add: (value: string) => {
        classListValues.add(value);
      },
      remove: (value: string) => {
        classListValues.delete(value);
      },
      contains: (value: string) => classListValues.has(value),
    },
  };
  Object.defineProperty(globalThis, "window", {
    value: {
      addEventListener: (type: string, handler: KeyHandler) => {
        if (type === "keydown") windowHandlers.add(handler);
      },
      removeEventListener: (type: string, handler: KeyHandler) => {
        if (type === "keydown") windowHandlers.delete(handler);
      },
      confirm: () => true,
      clearTimeout: () => {},
      setTimeout: () => 0,
      location: {
        href: "http://localhost/#/workflows/w1",
        hash: "#/workflows/w1",
      },
      history: {
        state: null,
        replaceState: () => {},
      },
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: {
      activeElement,
      body,
      addEventListener: (type: string, handler: KeyHandler) => {
        if (type === "keydown") documentHandlers.add(handler);
      },
      removeEventListener: (type: string, handler: KeyHandler) => {
        if (type === "keydown") documentHandlers.delete(handler);
      },
    },
    configurable: true,
    writable: true,
  });
}

function restoreDom() {
  Object.defineProperty(globalThis, "window", {
    value: originalWindow,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: originalDocument,
    configurable: true,
    writable: true,
  });
}

const mounted: ReactTestRenderer[] = [];

async function mount(node: React.ReactElement) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(node, { createNodeMock: () => fakeContainer as never });
    await Promise.resolve();
  });
  mounted.push(renderer);
  return renderer;
}

function findRole(renderer: ReactTestRenderer, role: string): ReactTestInstance[] {
  return renderer.root.findAll(
    (node) => node.props.role === role,
  );
}

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }
      if (child && typeof child === "object" && "children" in child) {
        return textOf(child as ReactTestInstance);
      }
      return "";
    })
    .join("");
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function findButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType("button")
    .find((button) => textOf(button).includes(label));
}

async function mountDetailPage() {
  state.api.mockImplementation(async (path: string) => {
    if (path === "/workflowbuilder/w1") {
      return {
        id: "w1",
        name: "Test workflow",
        enabled: true,
        nodes: [],
        edges: [],
      };
    }
    if (path === "/templates?limit=100") {
      return { data: [template], total: 1, page: 1, limit: 100 };
    }
    throw new Error(`Unexpected API path: ${path}`);
  });
  const renderer = await mount(<WorkflowDetailPage />);
  await flush();
  return renderer;
}

beforeEach(() => {
  installDom();
  state.role = undefined;
  state.api.mockResolvedValue({
    data: [template],
    total: 1,
    page: 1,
    limit: 100,
  });
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    act(() => renderer.unmount());
  }
  state.api.mockReset();
  state.onClose.mockReset();
  state.onSelect.mockReset();
  restoreDom();
});

describe("email template API contract", () => {
  it("reads the paginated envelope and accepts a bare array fallback", () => {
    const envelope = {
      data: [template, { ...template, id: "sms", channel: "SMS" }],
      total: 2,
      page: 1,
      limit: 100,
    };
    expect(parseEmailTemplates(envelope).map((row) => ({ ...row }))).toEqual([
      template,
    ]);
    expect(parseEmailTemplates([template]).map((row) => ({ ...row }))).toEqual([
      template,
    ]);
  });

  it.each([
    null,
    {},
    { data: {} },
    [null],
    [{ ...template, body: undefined }],
    [template, template],
  ])("rejects invalid template data", (input) => {
    expect(() => parseEmailTemplates(input)).toThrow();
  });

  it("rejects prototype-pollution keys without polluting the global object", () => {
    const payload = JSON.parse(
      '{"__proto__":{"polluted":true},"id":"tpl_2","name":"Bad","subject":"S","body":"B"}',
    ) as Record<string, unknown>;
    expect(() => parseEmailTemplates([payload])).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects unsafe key %s",
    (key) => {
      const row: Record<string, unknown> = {
        id: "tpl_3",
        name: "N",
        subject: "S",
        body: "B",
      };
      Object.defineProperty(row, key, {
        value: {},
        enumerable: true,
        configurable: true,
      });
      expect(() => parseEmailTemplates([row])).toThrow();
    },
  );
});

describe("email template helpers", () => {
  it.each([
    "Send Email",
    "send_email",
    "sendEmail",
    "Send-Email",
    "email",
    "EMAIL",
  ])("recognizes send-email action type %s", (value) => {
    expect(isSendEmail(value)).toBe(true);
  });

  it("does not treat unrelated actions as email", () => {
    expect(isSendEmail("condition")).toBe(false);
    expect(isSendEmail(undefined)).toBe(false);
  });

  it("splits merge tags from plain text", () => {
    expect(templateParts("Hi {{ contact.name }}!").map((part) => part.mergeTag)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("applies a template without discarding other action settings", () => {
    const config = { subject: "Custom", body: "Custom body", channel: "Email" };
    expect({ ...templateConfiguration(config, template) }).toEqual({
      subject: template.subject,
      body: template.body,
      channel: "Email",
      templateId: template.id,
    });
    expect({
      ...templateConfiguration({ ...config, templateId: "old" }, null),
    }).toEqual({ subject: "Custom", body: "Custom body", channel: "Email" });
  });
});

describe("role parity", () => {
  it.each(["owner", "Owner", "admin", "member"])(
    "allows manager role %s to configure templates",
    (role) => {
      expect(canConfigureTemplates(role, false)).toBe(true);
    },
  );

  it.each(["viewer", "", undefined])(
    "blocks non-manager role %s from configuring templates",
    (role) => {
      expect(canConfigureTemplates(role, false)).toBe(false);
    },
  );

  it("blocks configuration when the canvas is read-only", () => {
    expect(canConfigureTemplates("owner", true)).toBe(false);
  });
});

describe("preview rendering", () => {
  it("renders scripts, event handlers and javascript links as inert text", () => {
    const html = renderToStaticMarkup(
      <EmailTemplatePreview
        template={{
          ...template,
          subject: "<script>alert(1)</script>",
          body: '<img src=x onerror="alert(2)"> javascript:alert(3) {{name}}',
        }}
      />,
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/<[^>]*onerror=/iu);
    expect(html).not.toMatch(/href=/u);
    expect(html).toContain("email-merge-tag");
  });

  it("uses Drawer dialog semantics with a labelled title", () => {
    const html = renderToStaticMarkup(
      <ActionConfigPanel
        actionType="send_email"
        templateId=""
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    const label = html.match(/aria-labelledby="([^"]+)"/u)?.[1];
    expect(label).toBeTruthy();
    expect(html).toContain(`<h2 id="${label}">Action configuration</h2>`);
    expect(html).toContain('aria-label="Close"');
  });

  it("closes the Drawer on Escape and restores focus", async () => {
    const renderer = await mount(
      <ActionConfigPanel
        actionType="send_email"
        templateId=""
        onSelect={state.onSelect}
        onClose={state.onClose}
      />,
    );
    expect(classListValues.has("drawer-open")).toBe(true);
    expect(focusCalls).toBeGreaterThan(0);

    act(() => {
      for (const handler of Array.from(windowHandlers)) {
        handler({ key: "Escape", preventDefault() {} } as unknown as KeyboardEvent);
      }
    });
    expect(state.onClose).toHaveBeenCalledTimes(1);

    act(() => renderer.unmount());
  });
});

describe("selector states", () => {
  it("announces loading and uses an abortable api request", async () => {
    let resolve!: (value: unknown) => void;
    state.api.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const renderer = await mount(
      <EmailTemplateSelector templateId="" onSelect={() => {}} />,
    );
    expect(textOf(findRole(renderer, "status")[0])).toContain(
      "Loading email templates",
    );

    const [path, options] = state.api.mock.calls[0] as [
      string,
      { signal: AbortSignal },
    ];
    expect(path).toBe("/templates?limit=100");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(false);

    await act(async () => {
      resolve({ data: [template], total: 1, page: 1, limit: 100 });
      await Promise.resolve();
    });
    expect(findRole(renderer, "status")).toHaveLength(0);

    act(() => renderer.unmount());
    expect(options.signal.aborted).toBe(true);
  });

  it("announces an empty template list", async () => {
    state.api.mockResolvedValue({ data: [], total: 0, page: 1, limit: 100 });
    const renderer = await mount(
      <EmailTemplateSelector templateId="" onSelect={() => {}} />,
    );
    expect(textOf(findRole(renderer, "status")[0])).toContain(
      "No email templates yet",
    );
  });

  it("announces fetch failures and offers a retry", async () => {
    state.api.mockRejectedValue(new Error("network"));
    const renderer = await mount(
      <EmailTemplateSelector templateId="" onSelect={() => {}} />,
    );
    expect(textOf(findRole(renderer, "alert")[0])).toContain(
      "could not be loaded",
    );
    const retry = renderer.root
      .findAllByType("button")
      .find((button) => textOf(button).includes("Retry templates"));
    expect(retry).toBeDefined();
    const callsBefore = state.api.mock.calls.length;
    act(() => retry?.props.onClick());
    expect(state.api.mock.calls.length).toBe(callsBefore + 1);
  });

  it("announces an unavailable saved template", async () => {
    const renderer = await mount(
      <EmailTemplateSelector templateId="missing" onSelect={() => {}} />,
    );
    expect(textOf(findRole(renderer, "alert")[0])).toContain(
      "no longer available",
    );
  });
});

describe("workflow detail permissions", () => {
  it("lets an Owner edit the canvas and open the email template drawer", async () => {
    state.role = "Owner";
    const renderer = await mountDetailPage();
    const markup = JSON.stringify(renderer.toJSON());
    expect(markup).not.toContain("Read-only canvas.");
    expect(markup).toContain(
      "Save your canvas changes before leaving this workflow.",
    );

    const add = findButton(renderer, "Add Send Email");
    expect(add).toBeDefined();
    expect(add?.props.disabled).toBeFalsy();

    await act(async () => {
      add?.props.onClick();
      await Promise.resolve();
    });

    const flow = renderer.root.findAll(
      (node) => typeof node.props.onNodeClick === "function",
    )[0];
    expect(flow).toBeDefined();
    const emailNode = flow.props.nodes.find(
      (node: { data?: Record<string, unknown> }) =>
        node.data?.type === "send_email",
    );
    expect(emailNode).toBeDefined();

    await act(async () => {
      flow.props.onNodeClick({}, emailNode);
      await Promise.resolve();
    });

    const dialog = renderer.root.findAll(
      (node) => node.props.role === "dialog",
    )[0];
    expect(dialog).toBeDefined();
    const dialogMarkup = textOf(dialog);
    expect(dialogMarkup).toContain("Action configuration");
    expect(dialogMarkup).toContain("Email template");
  });

  it("keeps viewers on the read-only canvas", async () => {
    state.role = "viewer";
    const renderer = await mountDetailPage();
    const markup = JSON.stringify(renderer.toJSON());
    expect(markup).toContain("Read-only canvas.");
    expect(markup).not.toContain(
      "Save your canvas changes before leaving this workflow.",
    );
    expect(findButton(renderer, "Save")).toBeUndefined();
    expect(findButton(renderer, "Add Send Email")?.props.disabled).toBe(true);
  });
});

describe("canvas compatibility and responsive styles", () => {
  it("preserves the dev canvas foundation and adds the email action", () => {
    const html = renderToStaticMarkup(
      <AppProvider>
        <WorkflowCanvas workflow={{}} />
      </AppProvider>,
    );
    expect(html).toContain("react-flow__minimap");
    expect(html).toContain("react-flow__controls");
    expect(html).toContain("workflow-palette-item");
    expect(html).toContain("Add Send Email");
  });

  it("uses canonical tokens and a 768px breakpoint with no hardcoded hex", () => {
    const css = readFileSync(
      new URL("./emailTemplatePreview.css", import.meta.url),
      "utf8",
    );
    expect(css).toContain("@media (max-width: 768px)");
    expect(css).toContain("height: 480px");
    expect(css).toContain("min-height: 460px");
    expect(css).not.toContain(":has(");
    expect(css).not.toContain("900px");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    for (const token of [
      "--surface",
      "--border",
      "--text",
      "--muted",
      "--primary",
      "--focus-ring",
      "--shadow-lg",
    ]) {
      expect(css).toContain(token);
    }
  });
});
