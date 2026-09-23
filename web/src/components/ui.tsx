import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { api } from '../lib/api';

export function Modal({ title, children, onClose, footer }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode }) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return <div className="modal-backdrop" onMouseDown={onClose}>
    <section className="modal" onMouseDown={event => event.stopPropagation()}>
      <header><h3>{title}</h3><button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button></header>
      <div className="modal-body">{children}</div>
      {footer ? <footer>{footer}</footer> : null}
    </section>
  </div>;
}

export function Drawer({ title, subtitle, children, onClose, footer, width = 520 }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; footer?: ReactNode; width?: number }) {
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
    <aside className="side-drawer" style={{ width }} onMouseDown={event => event.stopPropagation()}>
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

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'blue' | 'green' | 'amber' | 'red' | 'purple' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
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
