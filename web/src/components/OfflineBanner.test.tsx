
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import OfflineBanner from "./OfflineBanner";

describe("OfflineBanner", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the banner when the browser is offline", () => {
    render(<OfflineBanner />);

    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("hides the banner and refreshes resources when the browser reconnects", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    render(<OfflineBanner />);

    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });

    fireEvent(window, new Event("online"));

    expect(screen.queryByRole("status")).toBeNull();
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tunaxa:resource-changed" }),
    );
  });

  it("does not trigger a retry while still offline", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    render(<OfflineBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(screen.getByRole("status")).toBeTruthy();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("triggers a resource refresh when Retry is clicked online", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    render(<OfflineBanner />);

    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(screen.queryByRole("status")).toBeNull();
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tunaxa:resource-changed" }),
    );
  });
});
