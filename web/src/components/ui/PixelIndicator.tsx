import React from 'react';

export interface PixelIndicatorProps {
  className?: string;
  colorClass?: string;
  active?: boolean;
  pulseColor?: 'blue' | 'emerald' | 'amber' | 'red' | string;
  size?: number;
}

export const PixelIndicator: React.FC<PixelIndicatorProps> = ({
  className = '',
}) => {

  return (
    <div className={`grid grid-cols-2 gap-0.5 w-3 h-3 shrink-0 ${className}`}>
      <span className="w-1.5 h-1.5 bg-[#3b82f6] opacity-100 animate-pulse" />
      <span className="w-1.5 h-1.5 bg-[#3b82f6] opacity-30" />
      <span className="w-1.5 h-1.5 bg-[#3b82f6] opacity-60" />
      <span className="w-1.5 h-1.5 bg-[#3b82f6] opacity-90" />
    </div>
  );
};


