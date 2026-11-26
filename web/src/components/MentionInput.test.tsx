import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MentionInput } from "./MentionInput";

const searchMock = vi.hoisted(() => vi.fn());
vi.mock("../modules/notifications/notificationActions", () => ({
  searchMentionableUsers: searchMock,
}));

describe("MentionInput presentation", () => {
  it("labels the input, renders mention chips and exposes combobox semantics", () => {
    const html = renderToStaticMarkup(
      <MentionInput
        label="Comment"
        value="Hello @sarah@example.com"
        onChange={vi.fn()}
      />,
    );
    expect(html).toContain("Mentions in this message");
    expect(html).toContain("mention-chip");
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('for="');
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("keeps read-only mention inputs disabled", () => {
    const html = renderToStaticMarkup(
      <MentionInput label="Comment" value="" onChange={vi.fn()} disabled />,
    );
    expect(html).toMatch(/<textarea[^>]*disabled/);
    expect(html).not.toContain('role="combobox"');
  });
});
