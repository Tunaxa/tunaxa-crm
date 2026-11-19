import { type ComponentProps } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CutButton } from "./CutButton";
import { PixelIndicator } from "./PixelIndicator";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mounted: ReactTestRenderer[] = [];

function mount(
  props: Partial<ComponentProps<typeof CutButton>> = {},
): ReactTestRenderer {
  const { children = "Save", ...rest } = props;
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<CutButton {...rest}>{children}</CutButton>);
  });
  mounted.push(renderer);
  return renderer;
}

function buttonOf(renderer: ReactTestRenderer) {
  return renderer.root.findByType("button");
}

afterEach(() => {
  while (mounted.length) {
    const renderer = mounted.pop()!;
    act(() => renderer.unmount());
  }
});

describe("CutButton", () => {
  it("renders a button with its accessible text and default styles", () => {
    const button = buttonOf(mount());

    expect(button.children.join("")).toBe("Save");
    expect(button.props.className).toContain("font-mono");
    expect(button.props.className).toContain("uppercase");
    expect(button.props.className).toContain("cursor-pointer");
    expect(button.props.className).toContain("px-5 py-2.5 text-xs");
    expect(button.props.className).toContain("bg-black text-white");
    expect(button.props.style).toMatchObject({
      clipPath: expect.stringContaining("polygon("),
    });
  });

  it.each([
    ["emerald", "lg", "bg-emerald-600", "px-7 py-3.5 text-sm"],
    ["coral", "sm", "bg-[#f43f5e]", "px-3.5 py-1.5 text-xs"],
  ] as const)(
    "applies %s / %s variant and size classes",
    (variant, size, variantClass, sizeClass) => {
      const className = String(
        buttonOf(mount({ variant, size })).props.className,
      );

      expect(className).toContain(variantClass);
      expect(className).toContain(sizeClass);
    },
  );

  it("forwards the disabled attribute and disabled styles", () => {
    const button = buttonOf(mount({ disabled: true }));

    expect(button.props.disabled).toBe(true);
    expect(button.props.className).toContain("disabled:opacity-50");
    expect(button.props.className).toContain("disabled:cursor-not-allowed");
  });

  it("renders a pixel indicator only when requested", () => {
    const withIndicator = mount({ pixelIndicator: true });
    const withoutIndicator = mount();

    expect(withIndicator.root.findAllByType(PixelIndicator)).toHaveLength(1);
    expect(withIndicator.root.findByType(PixelIndicator).props.colorClass).toBe(
      "bg-[#3b82f6]",
    );
    expect(withoutIndicator.root.findAllByType(PixelIndicator)).toHaveLength(0);
  });

  it("passes the variant-specific colour to the pixel indicator", () => {
    const renderer = mount({ variant: "emerald", pixelIndicator: true });

    expect(renderer.root.findByType(PixelIndicator).props.colorClass).toBe(
      "bg-white",
    );
  });

  it("invokes onClick when the button is clicked", () => {
    const onClick = vi.fn();
    const button = buttonOf(mount({ onClick }));

    act(() => {
      (button.props.onClick as () => void)();
    });

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
