import { useEffect, useId, useRef, useState } from "react";
import { insertMention, mentionHandles, mentionQuery, parseMentionUsers, type MentionUser } from "../modules/notifications/mentionModel";
import "../modules/notifications/notifications.css";

// The caller must supply a workspace-scoped lookup. The legacy /users endpoint
// is not scoped and must not be used as a source for this component.
export function MentionInput({ label, value, onChange, searchUsers, disabled = false }: {
  label: string; value: string; onChange: (value: string) => void;
  searchUsers?: (query: string, signal: AbortSignal) => Promise<unknown>; disabled?: boolean;
}) {
  const id = useId(), input = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(value.length), [users, setUsers] = useState<MentionUser[]>([]);
  const [active, setActive] = useState(0), [loading, setLoading] = useState(false), [error, setError] = useState(false), [dismissed, setDismissed] = useState(false);
  const range = mentionQuery(value, caret), query = range?.query;
  const handles = mentionHandles(value);
  useEffect(() => {
    setUsers([]); setActive(0); setError(false);
    if (query === undefined || !searchUsers || disabled || dismissed) { setLoading(false); return; }
    const abort = new AbortController(); setLoading(true);
    const timer = window.setTimeout(() => {
      searchUsers(query, abort.signal).then(result => { if (!abort.signal.aborted) setUsers(parseMentionUsers(result).slice(0, 10)); })
        .catch(() => { if (!abort.signal.aborted) setError(true); })
        .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    }, 200);
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [query, searchUsers, disabled, dismissed]);
  function choose(user: MentionUser) {
    if (!range || disabled) return;
    const next = insertMention(value, range, user);
    onChange(next.text); setCaret(next.caret); setDismissed(true); setUsers([]);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(next.caret, next.caret); });
  }
  const expanded = !!range && !!searchUsers && !disabled && !dismissed;
  return <div className="mention-input">
    <label className="field" htmlFor={id}><span>{label}</span></label>
    <textarea id={id} ref={input} rows={4} value={value} disabled={disabled} aria-describedby={`${id}-help`}
      role={searchUsers ? "combobox" : undefined} aria-autocomplete={searchUsers ? "list" : undefined} aria-expanded={searchUsers ? expanded : undefined}
      aria-controls={expanded ? `${id}-options` : undefined} aria-activedescendant={expanded && users[active] ? `${id}-option-${active}` : undefined}
      onChange={event => { onChange(event.target.value); setCaret(event.target.selectionStart); setDismissed(false); }}
      onSelect={event => { setCaret(event.currentTarget.selectionStart); }}
      onKeyDown={event => {
        if (!expanded) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDismissed(true); }
        if (!users.length) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActive(index => (index + (event.key === "ArrowDown" ? 1 : users.length - 1)) % users.length); }
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); choose(users[active]); }
      }} />
    <small id={`${id}-help`}>{searchUsers ? "Type @ to find a teammate. Use arrows and Enter to select." : "You can type @email mentions. Teammate suggestions are not available yet."}</small>
    {expanded && <><ul id={`${id}-options`} className="mention-options" role="listbox" aria-label="Teammate suggestions">{users.map((user, index) => <li key={user.id} id={`${id}-option-${index}`} role="option" aria-selected={active === index} onMouseDown={event => { event.preventDefault(); choose(user); }}>{user.name || user.email} · {user.email}</li>)}</ul>
      <p role={error ? "alert" : "status"}>{loading ? "Searching teammates…" : error ? "Could not load teammates. Edit your mention to retry." : users.length ? `${users.length} suggestions` : "No matching teammates."}</p></>}
    {!!handles.length && <div className="mention-chips" aria-label="Mentions in this message">{handles.map(handle => <span className="mention-chip" key={handle}>@{handle}</span>)}</div>}
  </div>;
}
