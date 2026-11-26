import { useEffect, useId, useRef, useState } from "react";
import {
  insertMention,
  mentionHandles,
  mentionQuery,
  type MentionUser,
} from "../modules/notifications/mentionModel";
import { searchMentionableUsers } from "../modules/notifications/notificationActions";
import "../modules/notifications/notifications.css";

export function MentionInput({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(value.length);
  const [users, setUsers] = useState<MentionUser[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const range = mentionQuery(value, caret);
  const query = range?.query;

  useEffect(() => {
    setUsers([]);
    setActive(0);
    setError(false);
    if (query === undefined || disabled || dismissed) {
      setLoading(false);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      searchMentionableUsers(query, abort.signal)
        .then((result) => {
          if (!abort.signal.aborted) setUsers(result.slice(0, 10));
        })
        .catch(() => {
          if (!abort.signal.aborted) setError(true);
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [query, disabled, dismissed]);

  function choose(user: MentionUser) {
    if (!range || disabled) return;
    const next = insertMention(value, range, user);
    onChange(next.text);
    setCaret(next.caret);
    setDismissed(true);
    setUsers([]);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(next.caret, next.caret);
    });
  }

  const expanded = !!range && !disabled && !dismissed;
  const handles = mentionHandles(value);
  return (
    <div className="mention-input">
      <label className="field" htmlFor={id}>
        <span>{label}</span>
      </label>
      <textarea
        id={id}
        ref={input}
        rows={4}
        value={value}
        disabled={disabled}
        aria-describedby={`${id}-help`}
        role={disabled ? undefined : "combobox"}
        aria-autocomplete={disabled ? undefined : "list"}
        aria-expanded={disabled ? undefined : expanded}
        aria-controls={expanded ? `${id}-options` : undefined}
        aria-activedescendant={
          expanded && users[active] ? `${id}-option-${active}` : undefined
        }
        onChange={(event) => {
          onChange(event.target.value);
          setCaret(event.target.selectionStart);
          setDismissed(false);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={(event) => {
          if (!expanded) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDismissed(true);
          }
          if (!users.length) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) =>
              (index + (event.key === "ArrowDown" ? 1 : users.length - 1)) %
              users.length,
            );
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            choose(users[active]);
          }
        }}
      />
      <small id={`${id}-help`}>
        Type @ to find a teammate. Use arrows and Enter to select.
      </small>
      {expanded ? (
        <>
          <ul
            id={`${id}-options`}
            className="mention-options"
            role="listbox"
            aria-label="Teammate suggestions"
          >
            {users.map((user, index) => (
              <li
                key={user.id}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={active === index}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(user);
                }}
              >
                {user.name || user.email} · {user.email}
              </li>
            ))}
          </ul>
          <p role={error ? "alert" : "status"}>
            {loading
              ? "Searching teammates…"
              : error
                ? "Could not load teammates. Edit your mention to retry."
                : users.length
                  ? `${users.length} suggestions`
                  : "No matching teammates."}
          </p>
        </>
      ) : null}
      {handles.length ? (
        <div className="mention-chips" aria-label="Mentions in this message">
          {handles.map((handle) => (
            <span className="mention-chip" key={handle}>
              @{handle}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
