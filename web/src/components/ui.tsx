import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { api } from '../lib/api';

const focusableSelector = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([hidden]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const initialFormFieldSelector = [
  'input:not([disabled]):not([hidden]):not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"])',
  'select:not([disabled]):not([hidden])',
  'textarea:not([disabled]):not([hidden])',
].join(',');

function useFocusTrap() {
  const containerRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const previousFocus = previousFocusRef.current;
    const getFocusableElements = () =>
      Array.from(container.querySelectorAll<HTMLElement>(focusableSelector));
    const focusFirst = () => {
      const focusableElements = getFocusableElements();
      const autofocusElement = container.querySelector<HTMLElement>('[autofocus]');
      const firstFormField = container.querySelector<HTMLElement>(initialFormFieldSelector);
      (autofocusElement || firstFormField || focusableElements[0] || container).focus();
    };

    focusFirst();

    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;

      const focusableElements = getFocusableElements();
      if (!focusableElements.length) {
        event.preventDefault();
        container.focus();
        return;
      }

      const firstFocusable = focusableElements[0];
      const lastFocusable = focusableElements[focusableElements.length - 1];
      if (!container.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? lastFocusable : firstFocusable).focus();
      } else if (event.shiftKey && document.activeElement === firstFocusable) {
        event.preventDefault();
        lastFocusable.focus();
      } else if (!event.shiftKey && document.activeElement === lastFocusable) {
        event.preventDefault();
        firstFocusable.focus();
      }
    };

    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      previousFocus?.focus();
    };
  }, []);

  return containerRef;
}
export { CornerBrackets } from './ui/CornerBrackets';
export { PixelIndicator } from './ui/PixelIndicator';
export { CutButton } from './ui/CutButton';
export { RevenueFlowCanvas } from './ui/RevenueFlowCanvas';
export { RevenueTicker } from './ui/RevenueTicker';
export { CountUpNumber } from './ui/CountUpNumber';
export { PixelDivider } from './ui/PixelDivider';
export { SectionHeader } from './ui/SectionHeader';
export type { SectionHeaderProps } from './ui/SectionHeader';

export function Modal({ title, children, onClose, footer }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode }) {
  const modalRef = useFocusTrap();

  useEffect(() => {
    const handler = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return <div className="modal-backdrop" onMouseDown={onClose}>
    <section ref={modalRef} className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onMouseDown={event => event.stopPropagation()}>
      <header><h3>{title}</h3><button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button></header>
      <div className="modal-body">{children}</div>
      {footer ? <footer>{footer}</footer> : null}
    </section>
  </div>;
}

export function Drawer({ title, subtitle, children, onClose, footer, width = 520 }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; footer?: ReactNode; width?: number }) {
  const drawerRef = useFocusTrap();

  useEffect(() => {
    const handler = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', handler);
    document.body.classList.add('drawer-open');
    return () => {
      window.removeEventListener('keydown', handler);
      document.body.classList.remove('drawer-open');
    };
  }, [onClose]);

  return <div className="drawer-backdrop" onMouseDown={onClose}>
    <aside ref={drawerRef} className="side-drawer" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} style={{ width }} onMouseDown={event => event.stopPropagation()}>
      <header className="side-drawer-head">
        <div><h2>{title}</h2>{subtitle ? <p>{subtitle}</p> : null}</div>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
      </header>
      <div className="side-drawer-body">{children}</div>
      {footer ? <footer className="side-drawer-footer">{footer}</footer> : null}
    </aside>
  </div>;
}

export function PageHeader({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return <div className="page-header"><div><h1>{title}</h1>{description ? <p>{description}</p> : null}</div><div className="page-actions">{children}</div></div>;
}

export function Empty({ icon, title, text, action }: { icon: string; title: string; text: string; action?: ReactNode }) {
  return <div className="empty-card">
    <span className="empty-icon"><Icon name={icon} size={25} /></span>
    <div className="empty-copy"><b>{title}</b><p>{text}</p></div>
    {action ? <div className="empty-action">{action}</div> : null}
  </div>;
}

export function Avatar({ name, src, size = 34 }: { name: string; src?: string; size?: number }) {
  const initials = name.split(/\s+/).filter(Boolean).map(x => x[0]).join('').slice(0, 2).toUpperCase() || 'NX';
  if (src) return <span className="avatar avatar-image" style={{ width: size, height: size }}><img src={src} alt="" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} /></span>;
  return <span className="avatar" style={{ width: size, height: size }}>{initials}</span>;
}

export interface BadgeProps {
  children: ReactNode;
  variant?: 'blue' | 'emerald' | 'amber' | 'red' | 'neutral';
  tone?: 'neutral' | 'blue' | 'green' | 'amber' | 'red' | 'purple';
  className?: string;
}

export function Badge({ children, variant, tone, className = '' }: BadgeProps) {
  if (variant) {
    const variantStyles: Record<string, string> = {
      blue: 'border-[#3b82f6]/40 bg-[#3b82f6]/10 text-[#2563eb] dark:text-[#60a5fa]',
      emerald: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
      amber: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
      red: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400',
      neutral: 'border-[#d1d1d1] dark:border-[#263140] bg-[#f7f7f7] dark:bg-[#121820] text-[#737373] dark:text-[#8b949e]',
    };
    const style = variantStyles[variant] || variantStyles.neutral;
    return (
      <span
        className={`inline-flex items-center px-2 py-0.5 border text-[10px] font-mono font-bold uppercase tracking-wider ${style} ${className}`}
      >
        {children}
      </span>
    );
  }
  return <span className={`badge badge-${tone || 'neutral'} ${className}`}>{children}</span>;
}

export function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return <button type="button" className={`toggle ${value ? 'on' : ''}`} aria-label={label} onClick={() => onChange(!value)} aria-pressed={value}><span /></button>;
}

export const money = (value: number, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(value || 0));

type PhotoFieldProps = {
  label: string;
  name: string;
  value?: string;
  radius?: number;
  onChange: (url: string) => void;
};

export function PhotoField({ label, name, value, radius = 56, onChange }: PhotoFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function pick(file?: File) {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('files', file);
      const [saved] = await api<{ url: string }[]>('/uploads', { method: 'POST', body: form });
      onChange(saved?.url || '');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return <div className="photo-field">
    <input ref={inputRef} hidden type="file" accept="image/*" onChange={e => pick(e.target.files?.[0])} />
    <span className="photo-preview" style={{ width: radius, height: radius }}>
      {value ? <img src={value} alt="" /> : <span>{name.split(/\s+/).filter(Boolean).map(x => x[0]).join('').slice(0, 2).toUpperCase() || 'NX'}</span>}
      <button type="button" className="photo-edit" onClick={() => inputRef.current?.click()} title="Change photo" disabled={busy}><Icon name="upload" /></button>
    </span>
    <div className="photo-field-actions">
      <span className="field"><span>{label}</span></span>
      <div>
        <button type="button" className="btn secondary compact" onClick={() => inputRef.current?.click()} disabled={busy}>{busy ? 'Uploading…' : 'Upload photo'}</button>
        {value ? <button type="button" className="btn ghost compact danger-link" onClick={() => onChange('')}>Remove</button> : null}
      </div>
    </div>
  </div>;
}
export { DataTable } from './ui/DataTable';
