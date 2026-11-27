import React, { useEffect, useRef, useState } from 'react';
import { TrendingUp, Zap, Clock, ShieldCheck, DollarSign, Activity } from 'lucide-react';
import { money } from '../../components/ui';
import { PixelIndicator } from './PixelIndicator';
import '../../modules/sales/winFlashTicker.css';

interface RevenueTickerProps {
  className?: string;
  total?: number;
  count?: number;
}

function reducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export const RevenueTicker: React.FC<RevenueTickerProps> = ({
  className = '',
  total,
  count,
}) => {
  const safeTotal =
    typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : 0;
  const safeCount =
    typeof count === 'number' && Number.isFinite(count) && count >= 0
      ? Math.floor(count)
      : 0;
  const [displayTotal, setDisplayTotal] = useState(safeTotal);
  const [pulse, setPulse] = useState(false);
  const frameRef = useRef<number | null>(null);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousRef = useRef(safeTotal);

  useEffect(() => {
    const cancelFrame = () => {
      if (frameRef.current !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
    const clearPulse = () => {
      if (pulseTimerRef.current !== null) {
        clearTimeout(pulseTimerRef.current);
        pulseTimerRef.current = null;
      }
    };

    cancelFrame();
    clearPulse();
    const start = previousRef.current;
    previousRef.current = safeTotal;
    if (start === safeTotal || reducedMotion() || typeof requestAnimationFrame !== 'function') {
      setDisplayTotal(safeTotal);
      return () => {
        cancelFrame();
        clearPulse();
      };
    }

    let startTime: number | null = null;
    const duration = 450;
    setPulse(true);
    const step = (now: number) => {
      if (startTime === null) startTime = now;
      const progress = Math.min((now - startTime) / duration, 1);
      setDisplayTotal(Math.round(start + (safeTotal - start) * progress));
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(step);
        return;
      }
      frameRef.current = null;
      setDisplayTotal(safeTotal);
      pulseTimerRef.current = setTimeout(() => setPulse(false), 900);
    };
    frameRef.current = requestAnimationFrame(step);
    return () => {
      cancelFrame();
      clearPulse();
    };
  }, [safeTotal]);

  const items = [
    { label: 'PIPELINE VELOCITY', val: '14.2 DAYS', sub: '-28% vs Industry', icon: Zap },
    { label: 'WIN RATE', val: '42.6%', sub: '+8.4% YoY', icon: TrendingUp },
    { label: 'ARR RUN-RATE', val: '$3,420,000', sub: 'Healthy Trajectory', icon: DollarSign },
    { label: 'ACTIVE DEALS', val: '128 IN FLIGHT', sub: '$1.84M Value', icon: Activity },
    { label: 'LEAD SLA', val: '< 3.2 MIN', sub: 'Instant Routing', icon: Clock },
    {
      label: 'WON REVENUE',
      val: money(displayTotal),
      sub: `${safeCount} won deal${safeCount === 1 ? '' : 's'}`,
      icon: ShieldCheck,
      highlight: true,
    },
  ];

  return (
    <div
      className={`revenue-ticker ${pulse ? 'revenue-ticker--pulse' : ''} ${className}`.trim()}
      aria-label="Live won revenue"
    >
      <div className="revenue-ticker__head">
        <PixelIndicator colorClass="revenue-ticker__pixel" />
        <span className="revenue-ticker__title">/ Sales velocity telemetry</span>
      </div>
      <div className="revenue-ticker__items">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <div
              key={item.label}
              className={`revenue-ticker__item ${item.highlight ? 'revenue-ticker__item--highlight' : ''}`.trim()}
            >
              <Icon
                className={`revenue-ticker__icon ${item.highlight ? 'revenue-ticker__icon--highlight' : ''}`.trim()}
              />
              <div>
                <span className="revenue-ticker__label">{item.label}</span>
                <span className="revenue-ticker__value">{item.val}</span>
              </div>
              <span className="revenue-ticker__sub">{item.sub}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
