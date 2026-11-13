import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { FormInput, FormSelect, FormTextarea, UserForm } from "../components/forms";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function attributeValues(markup: string, attribute: "id" | "for"): string[] {
  return [...markup.matchAll(new RegExp(`\\b${attribute}="([^"]*)"`, "g"))].map(
    (match) => match[1],
  );
}

function controlTag(markup: string, id: string): string {
  const match = markup.match(
    new RegExp(`<(?:input|select|textarea)\\b[^>]*\\bid="${id}"[^>]*>`),
  );

  if (!match) throw new Error(`no form control found with id "${id}"`);
  return match[0];
}

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? match[1] : null;
}

function createNodeMock() {
  return {
    focus: () => {},
    select: () => {},
    setCustomValidity: () => {},
    reportValidity: () => true,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("form field unique ids", () => {
  it("keeps two UserForm instances on one page free of duplicate ids", () => {
    const markup = renderToStaticMarkup(
      <>
        <UserForm onSubmit={() => {}} />
        <UserForm onSubmit={() => {}} />
      </>,
    );

    const allIds = attributeValues(markup, "id");
    const labelTargets = attributeValues(markup, "for");

    expect(labelTargets).toHaveLength(8);
    expect(allIds).toHaveLength(8);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(new Set(labelTargets).size).toBe(labelTargets.length);

    for (const target of labelTargets) {
      expect(allIds).toContain(target);
    }
  });
});

describe("form field ARIA attributes", () => {
  function FieldProbe() {
    const { control } = useForm<{ name: string; role: string; notes: string }>({
      defaultValues: { name: "", role: "", notes: "" },
    });

    return (
      <form>
        <FormInput
          name="name"
          control={control}
          label="Name"
          hint="Your full name"
          autoComplete="name"
          required
        />
        <FormSelect
          name="role"
          control={control}
          label="Role"
          options={[{ value: "admin", label: "Admin" }]}
          required
        />
        <FormTextarea
          name="notes"
          control={control}
          label="Notes"
          hint="Optional context"
        />
      </form>
    );
  }

  it("links labels, marks required fields, and describes hints without errors", () => {
    const markup = renderToStaticMarkup(<FieldProbe />);
    const labelTargets = attributeValues(markup, "for");

    expect(labelTargets).toHaveLength(3);
    expect(markup).not.toContain("aria-invalid");
    expect(markup.match(/aria-required="true"/g)).toHaveLength(2);

    for (const target of labelTargets) {
      expect(markup).toContain(`id="${target}"`);
    }

    const [nameId, roleId, notesId] = labelTargets;

    const nameControl = controlTag(markup, nameId);
    expect(attribute(nameControl, "aria-required")).toBe("true");
    expect(attribute(nameControl, "aria-describedby")).toBe(`${nameId}-hint`);
    expect(markup).toContain(
      `<p id="${nameId}-hint" class="form-field-hint">Your full name</p>`,
    );

    expect(attribute(controlTag(markup, roleId), "aria-required")).toBe("true");

    const notesControl = controlTag(markup, notesId);
    expect(attribute(notesControl, "aria-required")).toBeNull();
    expect(attribute(notesControl, "aria-describedby")).toBe(`${notesId}-hint`);
  });
});

describe("zod resolver error rendering", () => {
  it("renders role=alert errors with aria-invalid and error describedby links", async () => {
    const onSubmit = vi.fn();
    let renderer: ReactTestRenderer | undefined;

    act(() => {
      renderer = create(<UserForm onSubmit={onSubmit} />, { createNodeMock });
    });

    if (!renderer) throw new Error("UserForm did not render");
    const mounted = renderer;

    const form = mounted.root.find((node) => node.type === "form");
    await act(async () => {
      await form.props.onSubmit({
        preventDefault: () => {},
        persist: () => {},
      });
    });

    expect(onSubmit).not.toHaveBeenCalled();

    const alerts = mounted.root.findAll(
      (node) => node.type === "p" && node.props.role === "alert",
    );

    expect(alerts).toHaveLength(3);

    const errorIds = alerts.map((alert) => String(alert.props.id));
    expect(new Set(errorIds).size).toBe(3);

    for (const alert of alerts) {
      expect(String(alert.props.className)).toContain("form-field-error");
      expect(String(alert.props.children).length).toBeGreaterThan(0);
    }

    const invalidControls = mounted.root.findAll(
      (node) =>
        ["input", "select", "textarea"].includes(String(node.type)) &&
        node.props["aria-invalid"] === true,
    );

    expect(invalidControls).toHaveLength(3);

    for (const control of invalidControls) {
      expect(errorIds).toContain(control.props["aria-describedby"]);
      expect(control.props["aria-describedby"]).toBe(`${control.props.id}-error`);
    }
  });

  it("describes a field with both its hint and its error when both are present", async () => {
    const schema = z.object({ name: z.string().min(2, "Too short") });

    function HintErrorForm() {
      const { control, handleSubmit } = useForm<{ name: string }>({
        resolver: zodResolver(schema),
      });

      return (
        <form onSubmit={handleSubmit(() => {})}>
          <FormInput
            name="name"
            control={control}
            label="Name"
            hint="Your full name"
            required
          />
        </form>
      );
    }

    let renderer: ReactTestRenderer | undefined;

    act(() => {
      renderer = create(<HintErrorForm />, { createNodeMock });
    });

    if (!renderer) throw new Error("HintErrorForm did not render");
    const mounted = renderer;

    const form = mounted.root.find((node) => node.type === "form");
    await act(async () => {
      await form.props.onSubmit({
        preventDefault: () => {},
        persist: () => {},
      });
    });

    const input = mounted.root.find((node) => node.type === "input");
    const describedBy = String(input.props["aria-describedby"]).split(" ");

    expect(describedBy).toHaveLength(2);
    expect(describedBy).toContain(`${input.props.id}-hint`);
    expect(describedBy).toContain(`${input.props.id}-error`);

    expect(
      mounted.root.findAll(
        (node) => node.type === "p" && node.props.id === `${input.props.id}-hint`,
      ),
    ).toHaveLength(1);
    expect(
      mounted.root.findAll(
        (node) =>
          node.type === "p" && node.props.id === `${input.props.id}-error`,
      ),
    ).toHaveLength(1);
  });
});

describe("controlled value safety", () => {
  it("renders empty controlled values when defaultValues is omitted", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    function NoDefaultsProbe() {
      const { control } = useForm<{
        name: string;
        role: string;
        notes: string;
      }>();

      return (
        <>
          <FormInput name="name" control={control} label="Name" />
          <FormSelect name="role" control={control} label="Role" options={[]} />
          <FormTextarea name="notes" control={control} label="Notes" />
        </>
      );
    }

    let renderer: ReactTestRenderer | undefined;

    act(() => {
      renderer = create(<NoDefaultsProbe />, { createNodeMock });
    });

    if (!renderer) throw new Error("NoDefaultsProbe did not render");
    const mounted = renderer;

    expect(mounted.root.find((node) => node.type === "input").props.value).toBe(
      "",
    );
    expect(mounted.root.find((node) => node.type === "select").props.value).toBe(
      "",
    );
    expect(
      mounted.root.find((node) => node.type === "textarea").props.value,
    ).toBe("");

    const messages = errorSpy.mock.calls
      .map((args) => args.join(" "))
      .join("\n");

    expect(messages).not.toMatch(/uncontrolled/i);
  });
});
