import React, { useState, useEffect } from 'react';
import { TrendingUp, Zap, Clock, ShieldCheck, DollarSign, Activity } from 'lucide-react';
import { PixelIndicator } from './PixelIndicator';

interface RevenueTickerProps {
  className?: string;
}

export const RevenueTicker: React.FC<RevenueTickerProps> = ({ className = '' }) => {
  const [dealWonAmount, setDealWonAmount] = useState<number>(48500);
  const [velocityDays] = useState<number>(14.2);
  const [pulseWon, setPulseWon] = useState<boolean>(false);

  // Periodic subtle simulated deal activity
  useEffect(() => {
    const interval = setInterval(() => {
      const delta = Math.floor(Math.random() * 6000) + 1500;
      setDealWonAmount((prev) => prev + delta);
      setPulseWon(true);
      setTimeout(() => setPulseWon(false), 1200);
    }, 8000);
    return () => clearInterval(interval);
  }, []);

  const items = [
    { label: 'PIPELINE VELOCITY', val: `${velocityDays} DAYS`, sub: '-28% vs Industry', icon: Zap },
    { label: 'WIN RATE', val: '42.6%', sub: '+8.4% YoY', icon: TrendingUp },
    { label: 'ARR RUN-RATE', val: '$3,420,000', sub: 'Healthy Trajectory', icon: DollarSign },
    { label: 'ACTIVE DEALS', val: '128 IN FLIGHT', sub: '$1.84M Value', icon: Activity },
    { label: 'LEAD SLA', val: '< 3.2 MIN', sub: 'Instant Routing', icon: Clock },
    {
      label: 'CLOSED WON TODAY',
      val: `$${dealWonAmount.toLocaleString()}`,
      sub: 'Live Pipeline Win',
      icon: ShieldCheck,
      highlight: true,
    },
  ];

  return (
    <div
      className={`border border-[#d1d1d1] dark:border-[#263140] bg-white/90 dark:bg-[#0d1117]/90 backdrop-blur-xs py-2 px-4 font-mono text-[11px] overflow-hidden select-none ${className}`}
    >
      <div className="flex items-center justify-between gap-4 overflow-x-auto no-scrollbar whitespace-nowrap">
        <div className="flex items-center gap-2 shrink-0 border-r border-[#d1d1d1] dark:border-[#263140] pr-3 text-[#3b82f6]">
          <PixelIndicator colorClass="bg-[#10b981]" />
          <span className="font-bold tracking-wider uppercase text-[10px]">
            / SALES VELOCITY TELEMETRY
          </span>
        </div>

        <div className="flex items-center gap-6 divide-x divide-[#e5e5e5] dark:divide-[#263140]">
          {items.map((item, idx) => {
            const Icon = item.icon;
            const isHighlighted = item.highlight && pulseWon;
            return (
              <div
                key={idx}
                className={`flex items-center gap-2 pl-6 transition-all duration-300 ${
                  isHighlighted ? 'scale-105' : ''
                }`}
              >
                <Icon
                  className={`w-3.5 h-3.5 ${
                    item.highlight ? 'text-emerald-500 animate-bounce' : 'text-[#3b82f6]'
                  }`}
                />
                <div>
                  <span className="text-[9px] text-[#737373] dark:text-[#8b949e] uppercase block font-medium">
                    {item.label}
                  </span>
                  <span
                    className={`font-bold text-xs ${
                      item.highlight
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-[#171717] dark:text-white'
                    }`}
                  >
                    {item.val}
                  </span>
                </div>
                <span className="text-[9px] text-emerald-600 dark:text-emerald-400 hidden sm:inline ml-1 font-semibold">
                  {item.sub}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
