import { describe, expect, it } from "vitest";
import { insertMention, mentionHandles, mentionQuery, parseMentionUsers } from "./mentionModel";
const user = { id: "u_1", name: "Sarah Connor", email: "Sarah@example.com" };
describe("mention editor tokens", () => {
  it("finds a mention at the caret while preserving surrounding text", () => { expect(mentionQuery("Hello @sar world", 10)).toEqual({ start: 6, end: 10, query: "sar" }); });
  it("finds a bare @ at the start", () => { expect(mentionQuery("@", 1)?.query).toBe(""); });
  it("does not autocomplete inside an ordinary email address", () => { expect(mentionQuery("sarah@example.com", 9)).toBeNull(); });
  it("replaces the whole token when selecting in its middle", () => {
    const text = "Hello @sarah world", range = mentionQuery(text, 9)!;
    expect(insertMention(text, range, user).text).toBe("Hello @sarah@example.com world");
  });
  it("places the caret after an inserted email mention", () => {
    const result = insertMention("@sa", { start: 0, end: 3 }, user); expect(result.text).toBe("@sarah@example.com "); expect(result.caret).toBe(result.text.length);
  });
  it("normalizes and deduplicates suggestion emails", () => { expect(parseMentionUsers([user, { ...user, id: "u_2", email: "sarah@example.com" }])).toEqual([{ ...user, email: "sarah@example.com" }]); });
  it.each([{}, [{ ...user, email: "a@example.com\nBcc:x@example.com" }], [{ ...user, email: "a@example.com,b@example.com" }], [{ name: "Sarah", email: "sarah@example.com" }]])("rejects malformed suggestion rows", value => { expect(() => parseMentionUsers(value)).toThrow(); });
  it("renders unique email and name tokens matching backend syntax", () => { expect(mentionHandles("Hi @Sarah@example.com and @sarah.connor. Again @SARAH@example.com")).toEqual(["sarah@example.com", "sarah.connor"]); });
  it("ignores markup around tokens without returning markup", () => { expect(mentionHandles("<script>@sarah</script>")).toEqual(["sarah"]); });
});
