import React from 'react';

export interface BadgeProps {
  children: React.ReactNode;
  variant?: 'blue' | 'emerald' | 'amber' | 'red' | 'neutral';
  tone?: 'neutral' | 'blue' | 'green' | 'amber' | 'red' | 'purple';
  className?: string;
}

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant,
  tone,
  className = '',
}) => {
  // If tone is used from legacy CRM views, map it to variant
  const effectiveVariant = variant || (tone === 'green' ? 'emerald' : tone === 'purple' ? 'blue' : (tone as any)) || 'blue';

  const variantStyles: Record<string, string> = {
    blue: 'border-[#3b82f6]/40 bg-[#3b82f6]/10 text-[#2563eb] dark:text-[#60a5fa]',
    emerald: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    green: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    amber: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
    red: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400',
    neutral: 'border-[#d1d1d1] dark:border-[#263140] bg-[#f7f7f7] dark:bg-[#121820] text-[#737373] dark:text-[#8b949e]',
  };

  const style = variantStyles[effectiveVariant] || variantStyles.neutral;

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 border text-[10px] font-mono font-bold uppercase tracking-wider ${style} ${className}`}
    >
      {children}
    </span>
  );
};
