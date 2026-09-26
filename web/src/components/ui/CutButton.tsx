import React from 'react';
import { PixelIndicator } from './PixelIndicator';

interface CutButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'emerald' | 'outline' | 'coral';
  size?: 'sm' | 'md' | 'lg';
  pixelIndicator?: boolean;
  children: React.ReactNode;
}

export const CutButton: React.FC<CutButtonProps> = ({
  variant = 'primary',
  size = 'md',
  pixelIndicator = false,
  children,
  className = '',
  style,
  ...props
}) => {
  const baseStyles =
    'group relative inline-flex items-center gap-2.5 font-mono font-bold uppercase tracking-wider transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';

  const sizeStyles = {
    sm: 'px-3.5 py-1.5 text-xs',
    md: 'px-5 py-2.5 text-xs',
    lg: 'px-7 py-3.5 text-sm',
  };

  const variantStyles = {
    primary:
      'border border-black bg-black text-white hover:bg-neutral-800 dark:border-white dark:bg-white dark:text-black dark:hover:bg-neutral-200',
    secondary:
      'border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#121820] text-[#171717] dark:text-white hover:border-[#3b82f6] hover:text-[#3b82f6]',
    ghost:
      'border border-transparent bg-transparent text-[#737373] dark:text-[#8b949e] hover:text-[#171717] dark:hover:text-white',
    emerald:
      'border border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.3)]',
    // Design system aligned variants
    outline:
      'border border-[#d1d1d1] dark:border-[#263140] bg-transparent text-[#171717] dark:text-white hover:border-[#171717] dark:hover:border-white hover:bg-[#f0f0f0] dark:hover:bg-[#1a2233]',
    coral:
      'border border-[#f43f5e] bg-[#f43f5e] text-white hover:bg-[#e11d48] shadow-[0_0_15px_rgba(244,63,94,0.3)]',
  };

  const clipPathStyle = {
    clipPath:
      'polygon(6px 0%, 100% 0%, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0% 100%, 0% 6px)',
    ...style,
  };

  const indicatorColor =
    variant === 'primary'
      ? 'bg-[#3b82f6]'
      : variant === 'emerald'
      ? 'bg-white'
      : variant === 'coral'
      ? 'bg-white'
      : 'bg-[#3b82f6]';

  return (
    <button
      className={`${baseStyles} ${sizeStyles[size]} ${variantStyles[variant]} ${className}`}
      style={clipPathStyle}
      {...props}
    >
      {pixelIndicator && (
        <PixelIndicator colorClass={indicatorColor} />
      )}
      {children}
    </button>
  );
};
