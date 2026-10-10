export type MentionUser = { id: string; name: string; email: string };
export function mentionQuery(text: string, caret: number) {
  const prefix = text.slice(0, caret), match = prefix.match(/(?:^|[\s(])@([A-Za-z0-9._%+-]*)$/u);
  if (!match) return null;
  const start = caret - match[1].length - 1;
  let end = caret;
  while (end < text.length && /[A-Za-z0-9.@_%+-]/u.test(text[end])) end++;
  return { start, end, query: match[1] };
}
export function parseMentionUsers(value: unknown): MentionUser[] {
  if (!Array.isArray(value)) throw new Error("Invalid teammate response");
  const result: MentionUser[] = [], emails = new Set<string>();
  for (const item of value) {
    if (!item || typeof item.id !== "string" || !item.id || typeof item.name !== "string" || typeof item.email !== "string" || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/u.test(item.email)) throw new Error("Invalid teammate response");
    const email = item.email.toLowerCase();
    if (!emails.has(email)) { result.push({ id: item.id, name: item.name, email }); emails.add(email); }
  }
  return result;
}
export function insertMention(text: string, range: { start: number; end: number }, user: MentionUser) {
  const token = `@${parseMentionUsers([user])[0].email}`;
  const suffix = text.slice(range.end), separator = !suffix || !/^\s/u.test(suffix) ? " " : "";
  return { text: text.slice(0, range.start) + token + separator + suffix, caret: range.start + token.length + separator.length };
}
export function mentionHandles(text: string) {
  const pattern = /@([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/gu;
  return [...new Set([...text.matchAll(pattern)].map(match => match[1].toLowerCase()))];
}
