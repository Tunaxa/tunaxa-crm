import {
  containsDangerousKey,
  hasOwn,
  safeFields,
} from "../../components/records/urlSecurity";

export type MentionUser = { id: string; name: string; email: string };

const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/u;
const BOUNDARY_TOKEN_PATTERN =
  /(?:^|[^A-Za-z0-9_@])@([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/gu;
const TOKEN_CHAR_PATTERN = /[A-Za-z0-9.@_%+-]/u;

export function mentionQuery(text: string, caret: number) {
  const prefix = text.slice(0, caret);
  const match = prefix.match(/(?:^|[\s(])@([A-Za-z0-9._%+-]*)$/u);
  if (!match) return null;
  const start = caret - match[1].length - 1;
  let end = caret;
  while (end < text.length && TOKEN_CHAR_PATTERN.test(text[end])) end += 1;
  return { start, end, query: match[1] };
}

export function parseMentionUsers(value: unknown): MentionUser[] {
  if (!Array.isArray(value)) throw new Error("Invalid teammate response");
  const result: MentionUser[] = [];
  const emails = Object.create(null) as Record<string, true>;
  for (const item of value) {
    if (containsDangerousKey(item)) throw new Error("Invalid teammate response");
    const user = safeFields(item);
    if (
      typeof user.id !== "string" ||
      !user.id ||
      typeof user.name !== "string" ||
      typeof user.email !== "string" ||
      !EMAIL_PATTERN.test(user.email)
    ) {
      throw new Error("Invalid teammate response");
    }
    const email = user.email.toLowerCase();
    if (hasOwn(emails, email)) continue;
    emails[email] = true;
    result.push({ id: user.id, name: user.name, email });
  }
  return result;
}

export function insertMention(
  text: string,
  range: { start: number; end: number },
  user: MentionUser,
) {
  const token = `@${parseMentionUsers([user])[0].email}`;
  const suffix = text.slice(range.end);
  const separator = !suffix || !/^\s/u.test(suffix) ? " " : "";
  return {
    text: text.slice(0, range.start) + token + separator + suffix,
    caret: range.start + token.length + separator.length,
  };
}

export function mentionHandles(text: string): string[] {
  const handles = Object.create(null) as Record<string, true>;
  for (const match of text.matchAll(BOUNDARY_TOKEN_PATTERN)) {
    handles[match[1].toLowerCase()] = true;
  }
  return Object.keys(handles);
}
