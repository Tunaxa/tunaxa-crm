import { useEffect, useId, useRef, useState } from "react";
import { emailLink } from "./composerModel";

export function RichMessageEditor({ text, version, disabled, onChange }: { text: string; version: number; disabled: boolean; onChange: (body: string, html: string) => void }) {
  const ref = useRef<HTMLDivElement>(null), id = useId(), [error, setError] = useState("");
  useEffect(() => { if (ref.current) ref.current.textContent = text; }, [version]);
  function changed() { if (ref.current) onChange(ref.current.innerText || ref.current.textContent || "", ref.current.innerHTML); }
  function format(command: "bold" | "italic" | "createLink") {
    const selection = window.getSelection();
    if (!ref.current || !selection?.anchorNode || !selection.focusNode || !ref.current.contains(selection.anchorNode) || !ref.current.contains(selection.focusNode) || selection.isCollapsed) { setError("Select the message text you want to format first."); return; }
    setError(""); let value: string | undefined;
    if (command === "createLink") {
      const entered = prompt("Link URL (http:// or https://)"); if (entered === null) return;
      try { value = emailLink(entered); } catch { setError("Enter a valid HTTP or HTTPS link."); return; }
    }
    if (!document.execCommand(command, false, value)) setError("This browser could not apply that formatting.");
    changed();
  }
  return <div className="field"><span id={`${id}-label`}>Body *</span>
    <div className="mail-format-toolbar" role="toolbar" aria-label="Message formatting">{([['bold', 'Bold'], ['italic', 'Italic'], ['createLink', 'Link']] as const).map(([command, label]) => <button type="button" className="btn secondary compact" key={command} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => format(command)}>{label}</button>)}</div>
    {error && <p role="alert">{error}</p>}
    <div ref={ref} role="textbox" aria-labelledby={`${id}-label`} aria-multiline="true" aria-required="true" aria-disabled={disabled} tabIndex={disabled ? -1 : 0} className="mail-rich-body" contentEditable={!disabled} suppressContentEditableWarning onInput={changed}
      onPaste={event => { event.preventDefault(); if (!disabled) { document.execCommand("insertText", false, event.clipboardData.getData("text/plain")); changed(); } }} onDrop={event => event.preventDefault()} />
  </div>;
}
