import React, { useState } from 'react';
import {
  RotateCcw,
  Calendar,
  Sparkles,
  CheckCircle2,
  Plus,
} from 'lucide-react';
import { CornerBrackets } from '../ui/CornerBrackets';
import { PixelIndicator } from '../ui/PixelIndicator';
import { Badge } from '../ui/Badge';
import { CountUpNumber } from '../ui/CountUpNumber';

interface DealItem {
  id: string;
  company: string;
  title: string;
  value: number;
  stage: 'leads' | 'qualified' | 'proposal' | 'won';
  probability: number;
  closeDate: string;
  owner: string;
  avatar: string;
  priority?: 'HOT' | 'RENEWAL' | 'SCALE';
}

const INITIAL_DEALS: DealItem[] = [
  {
    id: 'd-1',
    company: 'Stripe Global',
    title: 'Enterprise Billing Sync',
    value: 84000,
    stage: 'proposal',
    probability: 75,
    closeDate: 'Sep 28, 2026',
    owner: 'Alex V.',
    avatar: 'SG',
    priority: 'HOT',
  },
  {
    id: 'd-2',
    company: 'Vercel Edge',
    title: '150-Seat Expansion',
    value: 45000,
    stage: 'qualified',
    probability: 60,
    closeDate: 'Oct 04, 2026',
    owner: 'Sarah K.',
    avatar: 'VE',
    priority: 'SCALE',
  },
  {
    id: 'd-3',
    company: 'Supabase Inc',
    title: 'Multi-Region Deal Desk',
    value: 62000,
    stage: 'leads',
    probability: 30,
    closeDate: 'Oct 15, 2026',
    owner: 'Marcus T.',
    avatar: 'SI',
    priority: 'RENEWAL',
  },
  {
    id: 'd-4',
    company: 'Linear Corp',
    title: 'Customer Success Hub',
    value: 38000,
    stage: 'leads',
    probability: 35,
    closeDate: 'Oct 22, 2026',
    owner: 'Alex V.',
    avatar: 'LC',
    priority: 'HOT',
  },
  {
    id: 'd-5',
    company: 'Datadog Platform',
    title: 'Automated Quote-to-Cash',
    value: 110000,
    stage: 'won',
    probability: 100,
    closeDate: 'Sep 02, 2026',
    owner: 'Sarah K.',
    avatar: 'DP',
    priority: 'HOT',
  },
];

const STAGES = [
  { id: 'leads', label: '1. INBOUND LEADS', color: 'text-[#3b82f6]', border: 'border-[#3b82f6]' },
  { id: 'qualified', label: '2. QUALIFIED', color: 'text-sky-500', border: 'border-sky-500' },
  { id: 'proposal', label: '3. PROPOSAL SENT', color: 'text-indigo-500', border: 'border-indigo-500' },
  { id: 'won', label: '4. CLOSED WON', color: 'text-emerald-500', border: 'border-emerald-500' },
] as const;

export const InteractivePipelineDemo: React.FC = () => {
  const [deals, setDeals] = useState<DealItem[]>(INITIAL_DEALS);
  const [justWonDealId, setJustWonDealId] = useState<string | null>(null);

  const totalWonRevenue = deals
    .filter((d) => d.stage === 'won')
    .reduce((acc, curr) => acc + curr.value, 0);

  const totalInFlightRevenue = deals
    .filter((d) => d.stage !== 'won')
    .reduce((acc, curr) => acc + curr.value, 0);

  const advanceStage = (dealId: string) => {
    setDeals((prev) =>
      prev.map((deal) => {
        if (deal.id !== dealId) return deal;
        if (deal.stage === 'leads') {
          return { ...deal, stage: 'qualified', probability: 60 };
        }
        if (deal.stage === 'qualified') {
          return { ...deal, stage: 'proposal', probability: 80 };
        }
        if (deal.stage === 'proposal') {
          setJustWonDealId(dealId);
          setTimeout(() => setJustWonDealId(null), 2400);
          return { ...deal, stage: 'won', probability: 100 };
        }
        return deal;
      })
    );
  };

  const injectTestDeal = () => {
    const companies = ['OpenAI Platform', 'Figma Org', 'Shopify Plus', 'Notion Labs', 'Retool Cloud'];
    const titles = ['Global License Renewal', '250-Seat RevOps Expansion', 'Multi-Region Inbound API Desk'];
    const values = [72000, 95000, 125000, 58000];

    const randomCompany = companies[Math.floor(Math.random() * companies.length)];
    const randomTitle = titles[Math.floor(Math.random() * titles.length)];
    const randomValue = values[Math.floor(Math.random() * values.length)];

    const newDeal: DealItem = {
      id: `injected-${Date.now()}`,
      company: randomCompany,
      title: randomTitle,
      value: randomValue,
      stage: 'leads',
      probability: 30,
      closeDate: 'Nov 12, 2026',
      owner: 'Alex V.',
      avatar: randomCompany.slice(0, 2).toUpperCase(),
      priority: 'HOT',
    };

    setDeals((prev) => [newDeal, ...prev]);
  };

  const resetPipeline = () => {
    setDeals(INITIAL_DEALS);
    setJustWonDealId(null);
  };

  return (
    <div className="relative border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#0d1117] p-5 sm:p-7 shadow-xl space-y-6">
      <CornerBrackets stroke="#3b82f6" size={10} />

      {/* Simulator Control Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#e5e5e5] dark:border-[#263140] pb-5">
        <div>
          <div className="flex items-center gap-2">
            <PixelIndicator pulseColor="emerald" />
            <span className="font-mono text-xs font-bold uppercase tracking-wider text-[#3b82f6]">
              / INTERACTIVE DEAL PIPELINE SIMULATOR
            </span>
            <Badge variant="emerald">LIVE SANDBOX</Badge>
          </div>
          <h3 className="text-lg font-bold font-mono uppercase text-[#171717] dark:text-white mt-1">
            EXPERIENCE DRAG-AND-DROP DEAL ACCELERATION
          </h3>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right font-mono text-xs hidden sm:block">
            <span className="text-[10px] text-[#737373] dark:text-[#8b949e] block uppercase">
              RECOGNIZED WON REVENUE:
            </span>
            <span className="text-emerald-600 dark:text-emerald-400 font-extrabold text-base flex items-center justify-end gap-1">
              <Sparkles className="w-3.5 h-3.5" />
              $<CountUpNumber value={totalWonRevenue} />
            </span>
          </div>

          <button
            type="button"
            onClick={injectTestDeal}
            className="px-3 py-1.5 border border-[#3b82f6] bg-[#3b82f6]/10 hover:bg-[#3b82f6] hover:text-white text-xs font-mono font-semibold uppercase tracking-wider text-[#3b82f6] transition-colors flex items-center gap-1.5 cursor-pointer"
            title="Inject an opportunity into the simulator"
          >
            <Plus className="w-3 h-3" />
            <span>+ INJECT OPPORTUNITY</span>
          </button>

          <button
            type="button"
            onClick={resetPipeline}
            className="px-3 py-1.5 border border-[#d1d1d1] dark:border-[#263140] hover:border-[#3b82f6] text-xs font-mono font-semibold uppercase tracking-wider text-[#737373] hover:text-[#171717] dark:text-[#8b949e] dark:hover:text-white transition-colors flex items-center gap-1.5 cursor-pointer"
            title="Reset to default pipeline state"
          >
            <RotateCcw className="w-3 h-3" />
            <span>RESET</span>
          </button>
        </div>
      </div>

      {/* Kanban Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {STAGES.map((stage) => {
          const stageDeals = deals.filter((d) => d.stage === stage.id);
          const stageTotal = stageDeals.reduce((sum, d) => sum + d.value, 0);

          return (
            <div
              key={stage.id}
              className="flex flex-col border border-[#e5e5e5] dark:border-[#263140] bg-[#f7f7f7] dark:bg-[#0a0e14] p-3 rounded-none relative"
            >
              {/* Stage Header */}
              <div className="flex items-center justify-between border-b border-[#e5e5e5] dark:border-[#263140] pb-2 mb-3">
                <span className={`text-xs font-mono font-bold uppercase tracking-wider ${stage.color}`}>
                  {stage.label}
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 bg-white dark:bg-[#121820] border border-[#d1d1d1] dark:border-[#263140] text-[#737373] dark:text-[#8b949e] font-bold">
                  ${(stageTotal / 1000).toFixed(0)}k ({stageDeals.length})
                </span>
              </div>

              {/* Deal Cards */}
              <div className="space-y-3 flex-1">
                {stageDeals.length === 0 ? (
                  <div className="p-6 text-center text-[11px] font-mono text-[#737373] dark:text-[#8b949e] border border-dashed border-[#d1d1d1] dark:border-[#263140]">
                    Empty stage
                  </div>
                ) : (
                  stageDeals.map((deal) => {
                    const isJustWon = deal.id === justWonDealId;
                    return (
                      <div
                        key={deal.id}
                        className={`hover-crm-card relative border bg-white dark:bg-[#121820] p-3.5 space-y-2.5 transition-all ${
                          isJustWon
                            ? 'border-emerald-500 ring-2 ring-emerald-500/50 animate-win-flash shadow-lg'
                            : 'border-[#d1d1d1] dark:border-[#263140]'
                        }`}
                      >
                        <CornerBrackets stroke={isJustWon ? '#10b981' : '#a1a1aa'} size={6} />

                        {/* Top: Avatar & Company */}
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="w-6 h-6 flex items-center justify-center bg-[#f7f7f7] dark:bg-[#1e242d] border border-[#d1d1d1] dark:border-[#263140] text-[10px] font-mono font-bold text-[#3b82f6]">
                              {deal.avatar}
                            </span>
                            <div>
                              <span className="text-xs font-mono font-bold text-[#171717] dark:text-white block truncate leading-tight">
                                {deal.company}
                              </span>
                              <span className="text-[10px] font-mono text-[#737373] dark:text-[#8b949e] block truncate">
                                {deal.title}
                              </span>
                            </div>
                          </div>

                          <div className="text-right">
                            <span className="text-xs font-mono font-extrabold text-[#171717] dark:text-white block">
                              ${deal.value.toLocaleString()}
                            </span>
                            {deal.priority && (
                              <span className="text-[9px] font-mono font-bold text-amber-600 dark:text-amber-400">
                                {deal.priority}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Progress Bar & Probability */}
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-[10px] font-mono text-[#737373] dark:text-[#8b949e]">
                            <span>Probability: {deal.probability}%</span>
                            <span>{deal.owner}</span>
                          </div>
                          <div className="w-full bg-[#e5e5e5] dark:bg-[#263140] h-1.5 overflow-hidden">
                            <div
                              className={`h-full transition-all duration-300 ${
                                deal.stage === 'won'
                                  ? 'bg-emerald-500'
                                  : deal.stage === 'proposal'
                                  ? 'bg-indigo-500'
                                  : 'bg-[#3b82f6]'
                              }`}
                              style={{ width: `${deal.probability}%` }}
                            />
                          </div>
                        </div>

                        {/* Card Action */}
                        <div className="pt-1 flex items-center justify-between border-t border-[#f0f0f0] dark:border-[#1e242d]">
                          <span className="text-[9px] font-mono text-[#737373] dark:text-[#8b949e] flex items-center gap-1">
                            <Calendar className="w-3 h-3" /> {deal.closeDate}
                          </span>

                          {deal.stage !== 'won' ? (
                            <button
                              type="button"
                              onClick={() => advanceStage(deal.id)}
                              className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono font-bold uppercase bg-[#3b82f6]/10 text-[#2563eb] dark:text-[#60a5fa] hover:bg-[#3b82f6] hover:text-white border border-[#3b82f6]/30 transition-colors cursor-pointer"
                              title="Advance deal to next sales stage"
                            >
                              <span>ADVANCE →</span>
                            </button>
                          ) : (
                            <span className="text-[10px] font-mono text-emerald-600 dark:text-emerald-400 font-bold flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3" /> CLOSED WON
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Live Pipeline Telemetry Summary Bar */}
      <div className="p-3 bg-[#f7f7f7] dark:bg-[#0a0e14] border border-[#d1d1d1] dark:border-[#263140] flex flex-wrap items-center justify-between gap-3 text-xs font-mono">
        <div className="flex items-center gap-4">
          <span className="text-[#737373] dark:text-[#8b949e]">
            ACTIVE PIPELINE:{' '}
            <strong className="text-[#171717] dark:text-white">
              $<CountUpNumber value={totalInFlightRevenue} />
            </strong>
          </span>
          <span className="text-neutral-300 dark:text-neutral-700">|</span>
          <span className="text-[#737373] dark:text-[#8b949e]">
            AVG CONVERSION RATE:{' '}
            <strong className="text-emerald-600 dark:text-emerald-400">42.6%</strong>
          </span>
          <span className="text-neutral-300 dark:text-neutral-700">|</span>
          <span className="text-[#737373] dark:text-[#8b949e]">
            SPEED-TO-LEAD:{' '}
            <strong className="text-[#3b82f6]">&lt; 3.2 MIN</strong>
          </span>
        </div>

        <div className="text-[10px] text-[#737373] dark:text-[#8b949e]">
          TELEMETRY STREAM: <span className="text-emerald-500 font-bold">● ACTIVE 60 FPS</span>
        </div>
      </div>
    </div>
  );
};
