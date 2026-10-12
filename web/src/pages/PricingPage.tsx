import React, { useState, useMemo } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Sparkles,
} from "lucide-react";
import {
  CornerBrackets,
  PixelIndicator,
  CutButton,
  Badge,
  CountUpNumber,
} from "../components/ui";
import { Navbar } from "../components/layout/Navbar";
import { Footer } from "../components/layout/Footer";

interface PricingPageProps {
  onNavigateToHome: () => void;
  onNavigateToLogin: () => void;
  onNavigateToDemo: () => void;
  onNavigateToSetup?: () => void;
}

const PRICING_FAQS = [
  {
    q: "CAN WE SWITCH PLANS OR ADD SEATS AT ANY TIME?",
    a: "Yes. Upgrades and seat expansions take effect immediately with prorated billing. If you downgrade or remove seats, credits apply to your next invoice with zero penalty fees.",
  },
  {
    q: "HOW DOES THE 50% TUNAXA ECOSYSTEM DISCOUNT WORK?",
    a: "If your company uses AXA PASS or any Tunaxa product, you qualify for an ongoing 50% discount on all CRM subscription tiers. This discount is applied automatically when you link your workspace account.",
  },
  {
    q: "ARE THERE ANY HIDDEN IMPLEMENTATION OR ONBOARDING FEES?",
    a: "None. Legacy CRM vendors typically charge $5,000 to $25,000 in mandatory implementation fees. Tunaxa AXA CRM is fully turnkey with 1-click CSV/Excel import tools and open GraphQL/REST endpoints.",
  },
  {
    q: "WHAT HAPPENS AFTER THE 14-DAY FREE TRIAL?",
    a: "You can select any tier to continue with all your customized deal stages, contacts, and automated workflows intact. No credit card is required to begin the trial.",
  },
  {
    q: "DOES AXA CRM SUPPORT SELF-HOSTING OR DEDICATED CLOUD DEPLOYMENTS?",
    a: "Yes! Our Enterprise tier provides private Docker containers or Kubernetes deployment manifests for AWS, GCP, Azure, or on-premise Linux environments.",
  },
  {
    q: "HOW SECURE IS OUR CLIENT AND DEAL DATA?",
    a: "All data is encrypted in transit (TLS 1.3) and at rest (AES-256). Furthermore, our integration with AXA PASS ensures client portal credentials and API keys are zero-knowledge encrypted end-to-end.",
  },
];

export const PricingPage: React.FC<PricingPageProps> = ({
  onNavigateToHome,
  onNavigateToLogin,
  onNavigateToDemo,
  onNavigateToSetup,
}) => {
  const [annualBilling, setAnnualBilling] = useState<boolean>(true);
  const [ecosystemDiscount, setEcosystemDiscount] = useState<boolean>(false);
  const [teamSeats, setTeamSeats] = useState<number>(10);
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  // Base tier pricing calculations
  const starterPrice = useMemo(() => {
    let price = annualBilling ? 15 : 19;
    if (ecosystemDiscount) price = price * 0.5;
    return price;
  }, [annualBilling, ecosystemDiscount]);

  const businessPrice = useMemo(() => {
    let price = annualBilling ? 49 : 59;
    if (ecosystemDiscount) price = price * 0.5;
    return price;
  }, [annualBilling, ecosystemDiscount]);

  const enterprisePerSeat = useMemo(() => {
    let price = annualBilling ? 7.5 : 9.0;
    if (ecosystemDiscount) price = price * 0.5;
    return price;
  }, [annualBilling, ecosystemDiscount]);

  // Calculator economics
  const axaCrmMonthly = useMemo(() => {
    if (teamSeats <= 3) {
      return starterPrice;
    } else if (teamSeats <= 10) {
      return businessPrice;
    } else {
      return Math.round(teamSeats * enterprisePerSeat);
    }
  }, [teamSeats, starterPrice, businessPrice, enterprisePerSeat]);

  const axaCrmAnnual = axaCrmMonthly * 12;
  const salesforceAnnual = teamSeats * 165 * 12;
  const hubspotAnnual = teamSeats * 100 * 12;
  const annualSavingsVsSalesforce = Math.max(
    0,
    salesforceAnnual - axaCrmAnnual,
  );
  const savingsPercentVsSalesforce = Math.round(
    ((salesforceAnnual - axaCrmAnnual) / salesforceAnnual) * 100,
  );

  return (
    <div className="min-h-screen bg-[#f7f7f7] dark:bg-[#090d13] text-[#1e2329] dark:text-[#f3f4f6] font-sans antialiased transition-colors duration-200 tunaxa-grid-texture relative selection:bg-[#3b82f6]/20">
      {/* Blueprint Floating Navbar */}
      <Navbar
        onNavigateToLogin={onNavigateToLogin}
        onNavigateToDemo={onNavigateToDemo}
        onNavigateToSetup={onNavigateToSetup}
        activeSection="pricing"
      />

      {/* Telemetry Ticker */}
      {/* <div className="pt-20">
        <RevenueTicker />
      </div> */}

      {/* Hero Section */}
      <section className="pt-20 pb-12 px-4 sm:px-6 md:px-12 max-w-7xl mx-auto relative">
        <div className="max-w-4xl space-y-5">
          <div className="inline-flex items-center gap-2">
            <PixelIndicator active pulseColor="emerald" />
            <Badge variant="blue">TUNAXA / AXA CRM PRICING BLUEPRINT</Badge>
          </div>

          <h1 className="text-3xl sm:text-5xl md:text-6xl font-extrabold tracking-tight text-[#18181b] dark:text-white uppercase font-sans leading-[1.08]">
            RADICAL REVENUE ECONOMICS.
            <span className="block text-[#3b82f6] dark:text-[#60a5fa] mt-1">
              ZERO COMPOUNDING SEAT TAX.
            </span>
          </h1>

          <p className="max-w-2xl text-sm sm:text-base text-[#52525b] dark:text-[#8b949e] leading-relaxed">
            Legacy CRM vendors penalize team growth with compounding $165/seat
            licensing fees. Tunaxa AXA CRM delivers complete pipeline
            intelligence, automated sequences, quotes, and webhooks at 75% to
            85% lower total cost of ownership.
          </p>

          {/* Global Billing Controls Card */}
          <div className="inline-flex flex-col sm:flex-row items-start sm:items-center gap-6 p-4 border border-[#d1d1d1] dark:border-[#21262d] bg-white dark:bg-[#161b22] shadow-sm relative">
            <CornerBrackets stroke="#3b82f6" size={8} />

            {/* Annual vs Monthly */}
            <div className="flex items-center gap-3">
              <span className="font-mono text-xs text-[#71717a] dark:text-[#8b949e]">
                BILLING INTERVAL:
              </span>
              <div className="flex items-center border border-[#d1d1d1] dark:border-[#21262d] p-0.5 bg-[#f4f4f5] dark:bg-[#0d1117]">
                <button
                  onClick={() => setAnnualBilling(false)}
                  className={`font-mono text-xs px-3 py-1.5 transition-colors cursor-pointer border-none ${
                    !annualBilling
                      ? "bg-white dark:bg-[#21262d] text-[#18181b] dark:text-white font-bold shadow-xs"
                      : "text-[#71717a] dark:text-[#8b949e] bg-transparent"
                  }`}
                >
                  MONTHLY
                </button>
                <button
                  onClick={() => setAnnualBilling(true)}
                  className={`font-mono text-xs px-3 py-1.5 transition-colors cursor-pointer border-none flex items-center gap-1.5 ${
                    annualBilling
                      ? "bg-[#3b82f6] text-white font-bold shadow-xs"
                      : "text-[#71717a] dark:text-[#8b949e] bg-transparent"
                  }`}
                >
                  ANNUAL
                  <span className="text-[10px] bg-emerald-500 text-white font-mono px-1 py-0.2 rounded-xs">
                    -16%
                  </span>
                </button>
              </div>
            </div>

            <div className="hidden sm:block h-6 w-[1px] bg-[#d1d1d1] dark:bg-[#21262d]" />

            {/* 50% Ecosystem Bundle Switch */}
            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={ecosystemDiscount}
                onChange={(e) => setEcosystemDiscount(e.target.checked)}
                className="w-4 h-4 text-[#3b82f6] rounded-none focus:ring-0 cursor-pointer accent-[#3b82f6]"
              />
              <div className="text-left">
                <span className="font-mono text-xs font-bold text-[#18181b] dark:text-white flex items-center gap-1">
                  <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                  50% TUNAXA ECOSYSTEM PASS
                </span>
                <span className="font-mono text-[10px] text-[#71717a] dark:text-[#8b949e] block">
                  Active AXA PASS or Tunaxa customer discount
                </span>
              </div>
            </label>
          </div>
        </div>
      </section>

      {/* Pricing Cards Grid */}
      <section className="py-8 px-4 sm:px-6 max-w-7xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 items-stretch">
          {/* TIER 1: STARTER */}
          <div className="border border-[#d1d1d1] dark:border-[#21262d] bg-white dark:bg-[#161b22] p-8 flex flex-col justify-between relative hover:border-[#a1a1aa] dark:hover:border-[#30363d] transition-all hover-crm-card">
            <CornerBrackets stroke="#71717a" size={10} />

            <div>
              <div className="flex justify-between items-center mb-4">
                <Badge variant="neutral">TIER 01</Badge>
                <span className="font-mono text-xs text-[#71717a] dark:text-[#8b949e]">
                  UP TO 3 SEATS
                </span>
              </div>

              <h2 className="text-2xl font-bold font-mono text-[#18181b] dark:text-white mb-2">
                STARTER
              </h2>
              <p className="text-xs text-[#52525b] dark:text-[#8b949e] mb-6 min-h-[36px]">
                Essential deal pipeline tracking and lead management for solo
                founders and agile squads.
              </p>

              {/* Price */}
              <div className="mb-6 pb-6 border-b border-[#e4e4e7] dark:border-[#21262d]">
                <div className="flex items-baseline gap-1">
                  <span className="text-4xl font-extrabold font-mono text-[#18181b] dark:text-white">
                    ${starterPrice.toFixed(starterPrice % 1 === 0 ? 0 : 2)}
                  </span>
                  <span className="font-mono text-xs text-[#71717a] dark:text-[#8b949e]">
                    / month
                  </span>
                </div>
                <div className="font-mono text-[11px] text-[#71717a] dark:text-[#8b949e] mt-1">
                  {annualBilling
                    ? "Billed annually ($" +
                      (starterPrice * 12).toFixed(0) +
                      "/yr)"
                    : "Billed monthly"}
                  {ecosystemDiscount && (
                    <span className="text-emerald-500 font-bold ml-1.5">
                      ● 50% PASS Applied
                    </span>
                  )}
                </div>
              </div>

              {/* Feature List */}
              <ul className="space-y-3 font-mono text-xs text-[#52525b] dark:text-[#8b949e] mb-8">
                <li className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>3 Included Team Seats</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>Unlimited Leads, Contacts & Accounts</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>Visual Kanban Sales Pipeline</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>Inbound Webhook Lead Ingestion</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>Email Templates & Interaction Notes</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>2 GB Document Storage</span>
                </li>
              </ul>
            </div>

            <CutButton
              variant="secondary"
              className="w-full"
              onClick={onNavigateToSetup || onNavigateToLogin}
            >
              START 14-DAY TRIAL
            </CutButton>
          </div>

          {/* TIER 2: BUSINESS TEAM (MOST POPULAR) */}
          <div className="border-2 border-[#3b82f6] bg-white dark:bg-[#161b22] p-8 flex flex-col justify-between relative shadow-xl hover-crm-card">
            <CornerBrackets stroke="#3b82f6" size={12} />

            <div className="absolute -top-3.5 right-6 bg-[#3b82f6] text-white font-mono text-[10px] uppercase font-bold tracking-wider px-3 py-0.5 shadow-sm">
              AXA CRM RECOMMENDED
            </div>

            <div>
              <div className="flex justify-between items-center mb-4">
                <Badge variant="blue">TIER 02 / ACCELERATOR</Badge>
                <span className="font-mono text-xs text-[#3b82f6] font-bold">
                  UP TO 10 SEATS
                </span>
              </div>

              <h2 className="text-2xl font-bold font-mono text-[#18181b] dark:text-white mb-2">
                BUSINESS TEAM
              </h2>
              <p className="text-xs text-[#52525b] dark:text-[#8b949e] mb-6 min-h-[36px]">
                High-velocity sales automation, multi-touch email sequences, and
                1-click quotes/invoicing.
              </p>

              {/* Price */}
              <div className="mb-6 pb-6 border-b border-[#e4e4e7] dark:border-[#21262d]">
                <div className="flex items-baseline gap-1">
                  <span className="text-4xl font-extrabold font-mono text-[#3b82f6] dark:text-[#60a5fa]">
                    ${businessPrice.toFixed(businessPrice % 1 === 0 ? 0 : 2)}
                  </span>
                  <span className="font-mono text-xs text-[#71717a] dark:text-[#8b949e]">
                    / month (flat for 10 seats)
                  </span>
                </div>
                <div className="font-mono text-[11px] text-[#71717a] dark:text-[#8b949e] mt-1">
                  Just ${(businessPrice / 10).toFixed(2)}/seat/mo |{" "}
                  {annualBilling ? "Billed annually" : "Billed monthly"}
                  {ecosystemDiscount && (
                    <span className="text-emerald-500 font-bold ml-1.5">
                      ● 50% PASS Applied
                    </span>
                  )}
                </div>
              </div>

              {/* Feature List */}
              <ul className="space-y-3 font-mono text-xs text-[#18181b] dark:text-[#c9d1d9] mb-8">
                <li className="flex items-center gap-2 font-bold text-[#3b82f6] dark:text-[#60a5fa]">
                  <Check className="w-4 h-4 text-[#3b82f6] dark:text-[#60a5fa] shrink-0" />
                  <span>Everything in Starter, plus:</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>10 Seats Included ($4.90/seat effective)</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>Automated Multi-Stage Email Sequences</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>1-Click Quotes, Invoices & Stripe Link</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>Native AXA PASS Credential Linking</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>Visual Workflow Trigger Automation</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>Revenue Forecasting & Multi-Currency</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>25 GB Document & Contract Storage</span>
                </li>
              </ul>
            </div>

            <CutButton
              variant="primary"
              className="w-full"
              onClick={onNavigateToSetup || onNavigateToLogin}
            >
              LAUNCH BUSINESS WORKSPACE
            </CutButton>
          </div>

          {/* TIER 3: ENTERPRISE */}
          <div className="border border-[#d1d1d1] dark:border-[#21262d] bg-white dark:bg-[#161b22] p-8 flex flex-col justify-between relative hover:border-[#a1a1aa] dark:hover:border-[#30363d] transition-all hover-crm-card">
            <CornerBrackets stroke="#71717a" size={10} />

            <div>
              <div className="flex justify-between items-center mb-4">
                <Badge variant="neutral">TIER 03</Badge>
                <span className="font-mono text-xs text-[#71717a] dark:text-[#8b949e]">
                  10+ SEATS
                </span>
              </div>

              <h2 className="text-2xl font-bold font-mono text-[#18181b] dark:text-white mb-2">
                ENTERPRISE
              </h2>
              <p className="text-xs text-[#52525b] dark:text-[#8b949e] mb-6 min-h-[36px]">
                Dedicated database instances, custom RBAC permissions,
                self-hosted deployment, and SLA governance.
              </p>

              {/* Price */}
              <div className="mb-6 pb-6 border-b border-[#e4e4e7] dark:border-[#21262d]">
                <div className="flex items-baseline gap-1">
                  <span className="text-4xl font-extrabold font-mono text-[#18181b] dark:text-white">
                    $
                    {enterprisePerSeat.toFixed(
                      enterprisePerSeat % 1 === 0 ? 0 : 2,
                    )}
                  </span>
                  <span className="font-mono text-xs text-[#71717a] dark:text-[#8b949e]">
                    / seat / month
                  </span>
                </div>
                <div className="font-mono text-[11px] text-[#71717a] dark:text-[#8b949e] mt-1">
                  {annualBilling ? "Billed annually" : "Billed monthly"} (min 10
                  seats)
                  {ecosystemDiscount && (
                    <span className="text-emerald-500 font-bold ml-1.5">
                      ● 50% PASS Applied
                    </span>
                  )}
                </div>
              </div>

              {/* Feature List */}
              <ul className="space-y-3 font-mono text-xs text-[#52525b] dark:text-[#8b949e] mb-8">
                <li className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>Unlimited Seats with Custom Roles (RBAC)</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>Dedicated Database / On-Premise Docker</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>HR, Leave, Attendance & Commissions</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>Full GraphQL Yoga & REST API Ingestion</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>Client Portal with Custom Domain</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>SSO, SAML & Enterprise Audit Logs</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>Dedicated Technical Account Director</span>
                </li>
              </ul>
            </div>

            <CutButton
              variant="secondary"
              className="w-full"
              onClick={onNavigateToSetup || onNavigateToLogin}
            >
              CONTACT SALES / TRIAL
            </CutButton>
          </div>
        </div>
      </section>

      {/* Interactive Seat Savings & TCO Calculator */}
      <section id="calculator" className="py-16 px-4 sm:px-6 max-w-7xl mx-auto">
        <div className="border border-[#d1d1d1] dark:border-[#21262d] bg-white dark:bg-[#161b22] p-8 sm:p-12 relative shadow-md">
          <CornerBrackets stroke="#3b82f6" size={14} />

          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-10 pb-8 border-b border-[#e4e4e7] dark:border-[#21262d]">
            <div>
              <div className="inline-flex items-center gap-2 mb-2">
                <PixelIndicator active pulseColor="emerald" />
                <span className="font-mono text-xs text-[#3b82f6] font-bold">
                  ROI & TCO ENGINE
                </span>
              </div>
              <h3 className="text-2xl sm:text-3xl font-bold font-mono text-[#18181b] dark:text-white">
                INTERACTIVE SEAT SAVINGS CALCULATOR
              </h3>
              <p className="text-xs text-[#52525b] dark:text-[#8b949e] font-mono mt-1">
                Calculate direct annual savings switching from Salesforce
                ($165/seat) or HubSpot ($100/seat) to Tunaxa AXA CRM.
              </p>
            </div>

            <div className="bg-[#f4f4f5] dark:bg-[#0d1117] border border-[#d1d1d1] dark:border-[#21262d] p-4 text-right">
              <span className="font-mono text-[10px] text-[#71717a] dark:text-[#8b949e] block">
                ANNUAL COST DIFFERENTIAL
              </span>
              <span className="font-mono text-3xl font-extrabold text-emerald-500 block">
                +<CountUpNumber value={savingsPercentVsSalesforce} />% SAVINGS
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
            {/* Left Controls: Seat Slider */}
            <div className="lg:col-span-6 space-y-6">
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="font-mono text-xs font-bold text-[#18181b] dark:text-white">
                    SALES & REVENUE SEATS:
                  </span>
                  <span className="font-mono text-xl font-extrabold text-[#3b82f6]">
                    {teamSeats} SEATS
                  </span>
                </div>

                <input
                  type="range"
                  min="2"
                  max="150"
                  value={teamSeats}
                  onChange={(e) => setTeamSeats(parseInt(e.target.value, 10))}
                  className="w-full h-2 bg-[#e4e4e7] dark:bg-[#21262d] rounded-lg appearance-none cursor-pointer accent-[#3b82f6]"
                />

                <div className="flex justify-between font-mono text-[10px] text-[#71717a] dark:text-[#8b949e] mt-2">
                  <span>2 Seats</span>
                  <span>25 Seats</span>
                  <span>50 Seats</span>
                  <span>100 Seats</span>
                  <span>150+ Seats</span>
                </div>
              </div>

              {/* Quick Preset Buttons */}
              <div className="flex flex-wrap items-center gap-2 pt-2">
                <span className="font-mono text-[11px] text-[#71717a] dark:text-[#8b949e] mr-2">
                  QUICK PRESETS:
                </span>
                {[3, 5, 10, 25, 50, 100].map((count) => (
                  <button
                    key={count}
                    onClick={() => setTeamSeats(count)}
                    className={`font-mono text-xs px-3 py-1 border transition-colors cursor-pointer ${
                      teamSeats === count
                        ? "border-[#3b82f6] bg-[#3b82f6]/10 text-[#3b82f6] font-bold"
                        : "border-[#d1d1d1] dark:border-[#21262d] bg-white dark:bg-[#0d1117] text-[#52525b] dark:text-[#8b949e]"
                    }`}
                  >
                    {count} SEATS
                  </button>
                ))}
              </div>

              <div className="p-4 border border-[#d1d1d1] dark:border-[#21262d] bg-[#fafafa] dark:bg-[#0d1117] font-mono text-xs text-[#52525b] dark:text-[#8b949e] space-y-2">
                <div className="flex justify-between">
                  <span>ACTIVE REVENUE TIER:</span>
                  <span className="font-bold text-[#18181b] dark:text-white">
                    {teamSeats <= 3
                      ? "STARTER TIER"
                      : teamSeats <= 10
                        ? "BUSINESS TEAM TIER"
                        : "ENTERPRISE TIER"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>ESTIMATED TUNAXA CRM MONTHLY:</span>
                  <span className="font-bold text-[#3b82f6]">
                    ${axaCrmMonthly.toLocaleString()} / mo
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>SALESFORCE CLOUD EQUIVALENT:</span>
                  <span className="font-bold text-red-500">
                    ${(teamSeats * 165).toLocaleString()} / mo
                  </span>
                </div>
              </div>
            </div>

            {/* Right Comparison Display */}
            <div className="lg:col-span-6 bg-[#fafafa] dark:bg-[#0d1117] border border-[#d1d1d1] dark:border-[#21262d] p-6 sm:p-8 space-y-6">
              <h4 className="font-mono text-xs font-bold uppercase tracking-wider text-[#71717a] dark:text-[#8b949e]">
                ANNUAL COST BENCHMARK ({teamSeats} USERS)
              </h4>

              {/* Salesforce Bar */}
              <div>
                <div className="flex justify-between font-mono text-xs mb-1">
                  <span className="text-[#18181b] dark:text-white font-bold">
                    SALESFORCE SALES CLOUD
                  </span>
                  <span className="text-red-500 font-bold">
                    ${salesforceAnnual.toLocaleString()} / yr
                  </span>
                </div>
                <div className="w-full bg-[#e4e4e7] dark:bg-[#21262d] h-3">
                  <div className="bg-red-500 h-3 w-full" />
                </div>
              </div>

              {/* HubSpot Bar */}
              <div>
                <div className="flex justify-between font-mono text-xs mb-1">
                  <span className="text-[#18181b] dark:text-white font-bold">
                    HUBSPOT SALES HUB
                  </span>
                  <span className="text-amber-500 font-bold">
                    ${hubspotAnnual.toLocaleString()} / yr
                  </span>
                </div>
                <div className="w-full bg-[#e4e4e7] dark:bg-[#21262d] h-3">
                  <div
                    className="bg-amber-500 h-3"
                    style={{
                      width: `${(hubspotAnnual / salesforceAnnual) * 100}%`,
                    }}
                  />
                </div>
              </div>

              {/* Tunaxa AXA CRM Bar */}
              <div>
                <div className="flex justify-between font-mono text-xs mb-1">
                  <span className="text-[#3b82f6] font-bold flex items-center gap-1.5">
                    <PixelIndicator active pulseColor="emerald" />
                    TUNAXA AXA CRM
                  </span>
                  <span className="text-emerald-500 font-bold">
                    ${axaCrmAnnual.toLocaleString()} / yr
                  </span>
                </div>
                <div className="w-full bg-[#e4e4e7] dark:bg-[#21262d] h-3">
                  <div
                    className="bg-[#3b82f6] h-3 transition-all duration-300"
                    style={{
                      width: `${Math.max(
                        3,
                        (axaCrmAnnual / salesforceAnnual) * 100,
                      )}%`,
                    }}
                  />
                </div>
              </div>

              {/* Net Annual Savings Card */}
              <div className="border border-emerald-500/30 bg-emerald-500/10 p-4 text-center mt-6">
                <span className="font-mono text-xs text-emerald-600 dark:text-emerald-400 block font-semibold mb-1">
                  NET ANNUAL REVENUE RETAINED
                </span>
                <span className="font-mono text-3xl sm:text-4xl font-extrabold text-emerald-600 dark:text-emerald-400">
                  $<CountUpNumber value={annualSavingsVsSalesforce} />
                  <span className="text-sm font-normal"> / YEAR</span>
                </span>
                <p className="font-mono text-[11px] text-[#52525b] dark:text-[#8b949e] mt-2">
                  Reinvest this capital into sales headcount, marketing
                  campaigns, or product engineering.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Comprehensive Feature Matrix Table */}
      <section id="matrix" className="py-16 px-4 sm:px-6 max-w-7xl mx-auto">
        <div className="text-center mb-12">
          <Badge variant="blue">CAPABILITY SPECIFICATION</Badge>
          <h3 className="text-2xl sm:text-3xl font-extrabold font-mono text-[#18181b] dark:text-white mt-2">
            DETAILED FEATURE COMPARISON
          </h3>
          <p className="text-xs text-[#71717a] dark:text-[#8b949e] font-mono mt-1">
            Complete transparency across all CRM tiers. No forced plan gates for
            core capabilities.
          </p>
        </div>

        <div className="border border-[#d1d1d1] dark:border-[#21262d] bg-white dark:bg-[#161b22] overflow-x-auto shadow-sm relative">
          <CornerBrackets stroke="#71717a" size={12} />

          <table className="w-full text-left font-mono text-xs border-collapse">
            <thead>
              <tr className="border-b border-[#d1d1d1] dark:border-[#21262d] bg-[#fafafa] dark:bg-[#0d1117]">
                <th className="p-4 sm:p-5 font-bold text-[#18181b] dark:text-white min-w-[220px]">
                  FEATURE / CAPABILITY
                </th>
                <th className="p-4 sm:p-5 font-bold text-[#18181b] dark:text-white text-center min-w-[140px]">
                  STARTER
                </th>
                <th className="p-4 sm:p-5 font-bold text-[#3b82f6] text-center min-w-[150px] bg-[#3b82f6]/5">
                  BUSINESS TEAM
                </th>
                <th className="p-4 sm:p-5 font-bold text-[#18181b] dark:text-white text-center min-w-[140px]">
                  ENTERPRISE
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#e4e4e7] dark:divide-[#21262d] text-[#52525b] dark:text-[#8b949e]">
              {/* Category: Pipeline & Deals */}
              <tr className="bg-[#f4f4f5] dark:bg-[#090d13] font-bold text-[#18181b] dark:text-white">
                <td
                  colSpan={4}
                  className="p-3.5 px-5 text-[11px] text-[#3b82f6]"
                >
                  PIPELINE & SALES ACCELERATION
                </td>
              </tr>
              <tr>
                <td className="p-4 px-5 font-semibold text-[#18181b] dark:text-white">
                  Included Team Seats
                </td>
                <td className="p-4 text-center">3 Seats</td>
                <td className="p-4 text-center font-bold text-[#3b82f6] bg-[#3b82f6]/5">
                  10 Seats Included
                </td>
                <td className="p-4 text-center">Unlimited (Custom)</td>
              </tr>
              <tr>
                <td className="p-4 px-5">Visual Kanban Deal Stages</td>
                <td className="p-4 text-center text-emerald-500">
                  <Check className="w-4 h-4 mx-auto" />
                </td>
                <td className="p-4 text-center text-emerald-500 bg-[#3b82f6]/5">
                  <Check className="w-4 h-4 mx-auto" />
                </td>
                <td className="p-4 text-center text-emerald-500">
                  <Check className="w-4 h-4 mx-auto" />
                </td>
              </tr>
              <tr>
                <td className="p-4 px-5">Lead Scoring & Routing Rules</td>
                <td className="p-4 text-center text-[#a1a1aa]">—</td>
                <td className="p-4 text-center text-emerald-500 bg-[#3b82f6]/5">
                  <Check className="w-4 h-4 mx-auto" />
                </td>
                <td className="p-4 text-center text-emerald-500">
                  <Check className="w-4 h-4 mx-auto" />
                </td>
              </tr>
              <tr>
                <td className="p-4 px-5">
                  Revenue Forecasting & Multi-Currency
                </td>
                <td className="p-4 text-center text-[#a1a1aa]">—</td>
                <td className="p-4 text-center text-emerald-500 bg-[#3b82f6]/5">
                  <Check className="w-4 h-4 mx-auto" />
                </td>
                <td className="p-4 text-center text-emerald-500">
                  <Check className="w-4 h-4 mx-auto" />
                </td>
              </tr>

              {/* Category: Automation & Sequences */}
              <tr className="bg-[#f4f4f5] dark:bg-[#090d13] font-bold text-[#18181b] dark:text-white">
                <td
                  colSpan={4}
                  className="p-3.5 px-5 text-[11px] text-[#3b82f6]"
                >
                  AUTOMATION & WORKFLOWS
                </td>
              </tr>
              <tr>
                <td className="p-4 px-5">Inbound Webhook Delivery Endpoints</td>
                <td className="p-4 text-center">3 Endpoints</td>
                <td className="p-4 text-center font-bold text-[#3b82f6] bg-[#3b82f6]/5">
                  Unlimited Endpoints
                </td>
                <td className="p-4 text-center">Unlimited Endpoints</td>
              </tr>
              <tr>
                <td className="p-4 px-5">
                  Automated Multi-Touch Email Sequences
                </td>
                <td className="p-4 text-center text-[#a1a1aa]">—</td>
                <td className="p-4 text-center text-emerald-500 bg-[#3b82f6]/5">
                  <Check className="w-4 h-4 mx-auto" />
                </td>
                <td className="p-4 text-center text-emerald-500">
                  <Check className="w-4 h-4 mx-auto" />
                </td>
              </tr>
              <tr>
                <td className="p-4 px-5">Event-Driven Workflow Automation</td>
                <td className="p-4 text-center text-[#a1a1aa]">
                  Basic Triggers
                </td>
                <td className="p-4 text-center text-emerald-500 bg-[#3b82f6]/5">
                  Advanced Visual Engine
                </td>
                <td className="p-4 text-center text-emerald-500">
                  Custom Code / Webhooks
                </td>
              </tr>

              {/* Category: Revenue & Billing */}
              <tr className="bg-[#f4f4f5] dark:bg-[#090d13] font-bold text-[#18181b] dark:text-white">
                <td
                  colSpan={4}
                  className="p-3.5 px-5 text-[11px] text-[#3b82f6]"
                >
                  COMMERCE & FINANCIALS
                </td>
              </tr>
              <tr>
                <td className="p-4 px-5">1-Click Quotes & Contracts</td>
                <td className="p-4 text-center text-[#a1a1aa]">—</td>
                <td className="p-4 text-center text-emerald-500 bg-[#3b82f6]/5">
                  <Check className="w-4 h-4 mx-auto" />
                </td>
                <td className="p-4 text-center text-emerald-500">
                  <Check className="w-4 h-4 mx-auto" />
                </td>
              </tr>
              <tr>
                <td className="p-4 px-5">Invoicing & Stripe Payment Links</td>
                <td className="p-4 text-center text-[#a1a1aa]">—</td>
                <td className="p-4 text-center text-emerald-500 bg-[#3b82f6]/5">
                  <Check className="w-4 h-4 mx-auto" />
                </td>
                <td className="p-4 text-center text-emerald-500">
                  <Check className="w-4 h-4 mx-auto" />
                </td>
              </tr>
              <tr>
                <td className="p-4 px-5">
                  HR, Attendance & Commission Tracking
                </td>
                <td className="p-4 text-center text-[#a1a1aa]">—</td>
                <td className="p-4 text-center text-[#a1a1aa] bg-[#3b82f6]/5">
                  —
                </td>
                <td className="p-4 text-center text-emerald-500">
                  <Check className="w-4 h-4 mx-auto" />
                </td>
              </tr>

              {/* Category: Security & Ecosystem */}
              <tr className="bg-[#f4f4f5] dark:bg-[#090d13] font-bold text-[#18181b] dark:text-white">
                <td
                  colSpan={4}
                  className="p-3.5 px-5 text-[11px] text-[#3b82f6]"
                >
                  SECURITY & INFRASTRUCTURE
                </td>
              </tr>
              <tr>
                <td className="p-4 px-5">Native AXA PASS Credential Linking</td>
                <td className="p-4 text-center text-[#a1a1aa]">—</td>
                <td className="p-4 text-center text-emerald-500 bg-[#3b82f6]/5">
                  <Check className="w-4 h-4 mx-auto" />
                </td>
                <td className="p-4 text-center text-emerald-500">
                  <Check className="w-4 h-4 mx-auto" />
                </td>
              </tr>
              <tr>
                <td className="p-4 px-5">Self-Hosted / On-Premise Docker</td>
                <td className="p-4 text-center text-[#a1a1aa]">—</td>
                <td className="p-4 text-center text-[#a1a1aa] bg-[#3b82f6]/5">
                  —
                </td>
                <td className="p-4 text-center text-emerald-500">
                  <Check className="w-4 h-4 mx-auto" />
                </td>
              </tr>
              <tr>
                <td className="p-4 px-5">Support Level</td>
                <td className="p-4 text-center">Community & Docs</td>
                <td className="p-4 text-center font-bold text-[#3b82f6] bg-[#3b82f6]/5">
                  Priority 24/7 Email
                </td>
                <td className="p-4 text-center font-bold">
                  Dedicated Account Director
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* FAQ Section */}
      <section id="faq" className="py-16 px-4 sm:px-6 max-w-4xl mx-auto">
        <div className="text-center mb-12">
          <Badge variant="neutral">TRANSPARENT TERMS</Badge>
          <h3 className="text-2xl sm:text-3xl font-bold font-mono text-[#18181b] dark:text-white mt-2">
            FREQUENTLY ASKED QUESTIONS
          </h3>
          <p className="text-xs text-[#71717a] dark:text-[#8b949e] font-mono mt-1">
            Answers to common questions regarding seats, migrations, and
            ecosystem billing.
          </p>
        </div>

        <div className="space-y-4">
          {PRICING_FAQS.map((item, index) => (
            <div
              key={index}
              className="border border-[#d1d1d1] dark:border-[#21262d] bg-white dark:bg-[#161b22] relative"
            >
              <button
                onClick={() => setOpenFaq(openFaq === index ? null : index)}
                className="w-full text-left p-5 flex items-center justify-between font-mono text-xs sm:text-sm font-bold text-[#18181b] dark:text-white bg-transparent border-none cursor-pointer"
              >
                <span>{item.q}</span>
                {openFaq === index ? (
                  <ChevronUp className="w-4 h-4 text-[#3b82f6] shrink-0" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-[#71717a] shrink-0" />
                )}
              </button>

              {openFaq === index && (
                <div className="px-5 pb-5 font-mono text-xs text-[#52525b] dark:text-[#8b949e] border-t border-[#e4e4e7] dark:border-[#21262d] pt-4 leading-relaxed">
                  {item.a}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* CTA Conversion Box */}
      <section className="py-16 px-4 sm:px-6 max-w-5xl mx-auto">
        <div className="border-2 border-[#3b82f6] bg-white dark:bg-[#161b22] p-8 sm:p-12 text-center relative shadow-lg">
          <CornerBrackets stroke="#3b82f6" size={14} />

          <div className="inline-flex items-center gap-2 mb-3">
            <PixelIndicator active pulseColor="blue" />
            <span className="font-mono text-xs text-[#3b82f6] font-bold tracking-wider">
              ZERO RISK / 14-DAY TEST RUN
            </span>
          </div>

          <h3 className="text-2xl sm:text-4xl font-extrabold font-mono text-[#18181b] dark:text-white mb-4">
            EXPERIENCE HIGH-VELOCITY SALES TODAY.
          </h3>

          <p className="max-w-xl mx-auto text-xs sm:text-sm text-[#52525b] dark:text-[#8b949e] font-mono mb-8">
            Deploy your workspace in under 60 seconds. Import your existing
            contacts and experience automated deal velocity without entering a
            credit card.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <CutButton
              variant="primary"
              size="lg"
              onClick={onNavigateToSetup || onNavigateToLogin}
            >
              LAUNCH YOUR CRM WORKSPACE
            </CutButton>
          </div>
        </div>
      </section>

      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <Footer
          onNavigateToHome={onNavigateToHome}
          onNavigateToPricing={() =>
            window.scrollTo({ top: 0, behavior: "smooth" })
          }
          onNavigateToDemo={onNavigateToDemo}
          onNavigateToLogin={onNavigateToLogin}
          onNavigateToSetup={onNavigateToSetup}
        />
      </div>
    </div>
  );
};
