import React from 'react';
import { PixelIndicator } from './PixelIndicator';

export interface SectionHeaderProps {
  /** Monospace badge text — e.g. "/ 01 SALES PIPELINE" */
  badge?: string;
  /** Large uppercase heading */
  title: string;
  /** Right-side meta label (uppercase monospace) */
  meta?: string;
  /** Optional CTA slot — e.g. a CutButton */
  action?: React.ReactNode;
  className?: string;
}

/**
 * SectionHeader — Blueprint section header matching the Tunaxa Design System v2.0.
 *
 * Usage:
 * ```tsx
 * <SectionHeader
 *   badge="/ 01 SALES"
 *   title="Active Leads"
 *   meta="47 RECORDS"
 *   action={<CutButton size="sm" pixelIndicator>NEW LEAD</CutButton>}
 * />
 * ```
 */
export const SectionHeader: React.FC<SectionHeaderProps> = ({
  badge,
  title,
  meta,
  action,
  className = '',
}) => {
  return (
    <div
      className={`
        border-b border-[#d1d1d1] dark:border-[#1e293b]
        pb-[18px] mb-9
        flex items-end justify-between flex-wrap gap-4
        ${className}
      `}
    >
      <div>
        {badge && (
          <div
            className="inline-flex items-center gap-2 px-3 py-[5px] mb-2"
            style={{
              fontFamily: 'var(--mono)',
              fontSize: '11px',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              background: 'var(--accent-badge-bg)',
              border: '1px solid var(--accent-badge-border)',
              color: 'var(--spectrum-royal)',
            }}
          >
            <PixelIndicator colorClass="bg-[#3b82f6]" />
            <span>{badge}</span>
          </div>
        )}
        <h2
          className="font-extrabold uppercase tracking-tight text-[#000000] dark:text-[#f8fafc] mt-1.5"
          style={{
            fontFamily: 'var(--mono)',
            fontSize: '28px',
            lineHeight: 1.15,
          }}
        >
          {title}
        </h2>
      </div>
      <div className="flex items-center gap-4">
        {meta && (
          <span
            className="uppercase"
            style={{
              fontFamily: 'var(--mono)',
              fontSize: '12px',
              color: 'var(--ink-faint)',
              letterSpacing: '0.05em',
            }}
          >
            {meta}
          </span>
        )}
        {action}
      </div>
    </div>
  );
};
