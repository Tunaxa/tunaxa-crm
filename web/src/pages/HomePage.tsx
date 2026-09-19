import React, { useState } from "react";
import {
  TrendingUp,
  Users,
  Zap,
  Building2,
  DollarSign,
  Check,
  ChevronDown,
  ChevronUp,
  ArrowRight,
  ShieldCheck,
  Workflow,
  Mail,
  FileText,
  Clock,
  Kanban,
  Headphones,
  Key,
  Globe,
  Activity,
  Award,
  Sparkles,
  Terminal,
  Send,
  CreditCard,
  MessageSquare,
  Lock,
  ExternalLink,
  Layers,
} from "lucide-react";
import {
  CornerBrackets,
  PixelIndicator,
  CutButton,
  Badge,
  RevenueTicker,
  PixelDivider,
} from "../components/ui";
import { AxacrmLogo } from "../components/common/AxacrmLogo";
import { Navbar } from "../components/layout/Navbar";
import { InteractivePipelineDemo } from "../components/pipeline/InteractivePipelineDemo";

interface HomePageProps {
  onNavigateToLogin: () => void;
  onNavigateToPricing: () => void;
  onNavigateToDemo: () => void;
  onNavigateToSetup?: () => void;
}

const FAQS = [
  {
    q: "HOW DOES AXA CRM ELIMINATE THE SALESFORCE PER-SEAT TAX?",
    a: "Legacy vendors like Salesforce ($165/seat/mo) and HubSpot ($100/seat/mo) charge compounding per-seat fees that penalize growing sales teams. AXA CRM provides full-suite pipeline capabilities, automated sequences, quotes, and webhooks with transparent pricing that is 75% to 85% lower in total cost of ownership.",
  },
  {
    q: "CAN WE MIGRATE EXISTING LEADS, CONTACTS, AND DEALS FROM HUBSPOT OR SALESFORCE?",
    a: "Yes. AXA CRM includes built-in CSV/Excel data import utilities and dedicated REST/GraphQL migration endpoints. Standard fields, custom properties, deal stages, and interaction notes import cleanly in minutes without data loss.",
  },
  {
    q: "HOW DOES AXA CRM CONNECT WITH AXA PASS PASSWORD MANAGER?",
    a: "AXA CRM features native 1-click zero-knowledge credential linking with AXA PASS. Sales reps and account managers can securely store, hand off, and rotate client portal passwords and API keys directly inside deal records without exposing plaintexts across insecure Slack or email threads.",
  },
  {
    q: "WHAT AUTOMATIONS ARE INCLUDED IN THE BUSINESS TEAM TIER?",
    a: "Business Team includes visual trigger-action workflows, multi-stage automated email sequences with smart pause-on-reply, webhook ingestion for web forms, automated task assignment based on lead scores, and 1-click quote-to-invoice generation.",
  },
  {
    q: "CAN AXA CRM BE SELF-HOSTED OR DEPLOYED ON PRIVATE CLOUD INFRASTRUCTURE?",
    a: "Yes. Enterprise tiers support private container deployments on AWS, Google Cloud, or bare-metal Linux with PostgreSQL, Redis, and BullMQ background task processing under your own security perimeters and compliance governance.",
  },
  {
    q: "HOW DOES THE 50% TUNAXA ECOSYSTEM DISCOUNT WORK?",
    a: "If your organization uses AXA PASS or any active Tunaxa product, you automatically qualify for an ongoing 50% discount on all CRM tiers. Simply toggle the ecosystem discount switcher when activating your workspace.",
  },
];

const METRICS = [
  {
    value: "05",
    label: "PIPELINE STAGES",
    detail: "Inbound leads to closed-won telemetry",
  },
  {
    value: "75%",
    label: "TCO REDUCTION",
    detail: "Zero predatory per-seat licensing tax",
  },
  {
    value: "< 20ms",
    label: "EDGE SYNC LATENCY",
    detail: "Global real-time deal webhooks",
  },
  {
    value: "1-CLICK",
    label: "QUOTES TO CASH",
    detail: "Instant legal PDF & invoice generation",
  },
];

const CAPABILITIES = [
  {
    tag: "/SALES & PIPELINE",
    title: "Visual Kanban Deal Desk",
    subtitle: "High-velocity visual stage progression",
    description:
      "Manage complex multi-tier sales cycles with customizable Kanban stages, deal velocity warnings, stage-specific required fields, and automated probability weighting.",
    features: [
      "Multi-pipeline custom stage management",
      "Automated deal velocity & stagnation alerts",
      "Loss reason tracking & conversion analytics",
    ],
    icon: <Kanban className="w-5 h-5 text-[#3b82f6]" />,
  },
  {
    tag: "/AUTOMATION ENGINE",
    title: "Intelligent Follow-Up Sequences",
    subtitle: "Multi-touch automated communication cadences",
    description:
      "Keep prospects engaged with smart drip sequences that automatically pause the moment a lead replies, books a call, or signs a digital agreement.",
    features: [
      "Smart pause-on-reply detection",
      "Dynamic variable merging for personalization",
      "Deliverability & open rate telemetry",
    ],
    icon: <Workflow className="w-5 h-5 text-emerald-500" />,
  },
  {
    tag: "/CONTACT INTELLIGENCE",
    title: "360° Interaction Timeline",
    subtitle: "Unified prospect communication history",
    description:
      "Consolidate emails, calls, notes, quote views, and support tickets into an immutable timeline. Zero fragmented communication across reps.",
    features: [
      "Full contact & company relationship graphs",
      "Automated email sync & conversation threading",
      "Custom metadata properties & tags",
    ],
    icon: <Users className="w-5 h-5 text-indigo-500" />,
  },
  {
    tag: "/REVENUE TELEMETRY",
    title: "Forecasting & Quotes-to-Cash",
    subtitle: "Accurate revenue projections & instant billing",
    description:
      "Generate professional PDF quotes with custom product line items, discount authorizations, and instant conversion into payable invoices upon deal win.",
    features: [
      "Weighted revenue pipeline forecasting",
      "1-click quote to invoice conversion",
      "Product catalog & pricing tiered discounting",
    ],
    icon: <TrendingUp className="w-5 h-5 text-amber-500" />,
  },
  {
    tag: "/CREDENTIAL SECURITY",
    title: "AXA PASS Zero-Knowledge Link",
    subtitle: "Encrypted client secrets & API keys",
    description:
      "Store client portal passwords, staging credentials, and vendor API tokens directly inside deal records backed by zero-knowledge end-to-end encryption.",
    features: [
      "Zero-knowledge encryption backed by Argon2id",
      "Role-based access controls for deal owners",
      "Automated credential rotation & audit logs",
    ],
    icon: <ShieldCheck className="w-5 h-5 text-sky-500" />,
  },
  {
    tag: "/INFRASTRUCTURE",
    title: "Self-Host & Private Cloud",
    subtitle: "Complete data sovereignty & governance",
    description:
      "Deploy on your own private cloud or bare-metal servers with Docker and Kubernetes manifests. Keep customer data strictly within your jurisdiction.",
    features: [
      "PostgreSQL & Redis enterprise backend",
      "Open REST & GraphQL ingestion endpoints",
      "Air-gapped deployment option for compliance",
    ],
    icon: (
      <Terminal className="w-5 h-5 text-neutral-500 dark:text-neutral-300" />
    ),
  },
];

export const HomePage: React.FC<HomePageProps> = ({
  onNavigateToLogin,
  onNavigateToPricing,
  onNavigateToDemo,
  onNavigateToSetup,
}) => {
  const [calculatorSeats, setCalculatorSeats] = useState<number>(25);
  const [competitorType, setCompetitorType] = useState<
    "salesforce" | "hubspot" | "pipedrive"
  >("salesforce");
  const [hasPassDiscount, setHasPassDiscount] = useState<boolean>(false);
  const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(0);

  const competitorPricingMap = {
    salesforce: { name: "Salesforce Sales Cloud Enterprise", seat: 165.0 },
    hubspot: { name: "HubSpot Sales Hub Professional", seat: 100.0 },
    pipedrive: { name: "Pipedrive Professional Suite", seat: 79.0 },
  };

  const selectedCompetitor = competitorPricingMap[competitorType];
  const axaSeatPrice = hasPassDiscount ? 4.5 : 9.0;

  const monthlyCompetitorCost = calculatorSeats * selectedCompetitor.seat;
  const monthlyAxaCost = calculatorSeats * axaSeatPrice;
  const annualSavings = (monthlyCompetitorCost - monthlyAxaCost) * 12;
  const threeYearSavings = annualSavings * 3;
  const savingsPercent = Math.round(
    (1 - monthlyAxaCost / (monthlyCompetitorCost || 1)) * 100,
  );

  const handleLaunchWorkspace = onNavigateToSetup || onNavigateToLogin;

  return (
    <div className="min-h-screen bg-[#f7f7f7] dark:bg-[#0a0e14] text-[#171717] dark:text-[#f3f4f6] font-sans antialiased selection:bg-[#3b82f6] selection:text-white">
      {/* Background Subtle Blueprint Radial Dot Grid Texture matching tunaxa-website */}
      <div
        className="fixed inset-0 pointer-events-none opacity-40 dark:opacity-20 z-0"
        style={{
          backgroundImage: `radial-gradient(#d1d1d1 1px, transparent 1px)`,
          backgroundSize: "24px 24px",
        }}
      />

      {/* Floating Blueprint Navigation Bar */}
      <Navbar
        onNavigateToLogin={onNavigateToLogin}
        onNavigateToPricing={onNavigateToPricing}
        onNavigateToDemo={onNavigateToDemo}
        onNavigateToSetup={onNavigateToSetup}
      />

      {/* Main Container matching tunaxa-website spacing */}
      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 md:px-12 pt-28 pb-24 space-y-16">
        {/* ══════════════════════════════════════════════════════════
            1. HERO SECTION (Framing Card matching tunaxa-website)
            ══════════════════════════════════════════════════════════ */}
        <section className="relative w-full space-y-10">
          <div className="relative border border-[#d1d1d1] dark:border-[#263140] bg-[#f7f7f7] dark:bg-[#0f1217] p-8 md:p-14 lg:p-16 shadow-xs">
            <CornerBrackets />

            <div className="max-w-4xl space-y-6">
              {/* System Badge */}
              <div className="inline-flex items-center gap-3 px-3.5 py-1.5 border border-[#bfdbfe] dark:border-[#1e3a8a] bg-[#eff6ff] dark:bg-[#172554] text-[#2563eb] dark:text-[#60a5fa] text-xs font-mono font-semibold uppercase tracking-wider">
                <PixelIndicator pulseColor="blue" active />
                <span>TUNAXA / AXA CRM BLUEPRINT</span>
              </div>

              {/* High-Stakes Headline */}
              <h1 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-extrabold tracking-tight uppercase text-black dark:text-white font-sans leading-[1.08]">
                ENGINEERED FOR VELOCITY. <br className="hidden sm:inline" />
                BUILT WITHOUT THE{" "}
                <span className="text-[#3b82f6] dark:text-[#60a5fa]">
                  SALESFORCE TAX
                </span>
              </h1>

              {/* Value Proposition Description */}
              <p className="text-base sm:text-lg text-neutral-600 dark:text-neutral-300 font-light leading-relaxed max-w-2xl">
                Tunaxa AXA CRM unifies core revenue operations—visual deal
                pipelines, contact intelligence, automated sequences,
                quotes-to-cash, and forecasting—into a single high-performance
                software ecosystem at fair, transparent rates.
              </p>

              {/* Dual Action Buttons matching tunaxa-website */}
              <div className="pt-4 flex flex-col sm:flex-row items-stretch sm:items-center gap-4">
                {/* Primary Cut-Corner Button */}
                <button
                  onClick={handleLaunchWorkspace}
                  className="group relative inline-flex items-center justify-between gap-4 px-7 py-3.5 border border-black bg-black text-white dark:bg-white dark:text-black dark:border-white text-sm font-mono font-semibold uppercase tracking-wider transition-all duration-200 hover:bg-transparent hover:text-black dark:hover:bg-transparent dark:hover:text-white cursor-pointer"
                  style={{
                    clipPath:
                      "polygon(8px 0%, 100% 0%, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0% 100%, 0% 8px)",
                  }}
                >
                  <div className="flex items-center gap-2.5">
                    <PixelIndicator pulseColor="blue" active />
                    <span>Launch Workspace</span>
                  </div>
                  <span className="transform group-hover:translate-x-1 transition-transform font-mono text-[#3b82f6] dark:text-[#60a5fa]">
                    →
                  </span>
                </button>

                {/* Tertiary Pricing Button */}
                <button
                  onClick={onNavigateToPricing}
                  className="group relative inline-flex items-center justify-between gap-4 px-7 py-3.5 border border-[#d1d1d1] dark:border-[#263140] bg-transparent text-black dark:text-white text-sm font-mono font-semibold uppercase tracking-wider transition-all duration-200 hover:border-[#3b82f6] cursor-pointer"
                >
                  <span>View Pricing &amp; ROI</span>
                  <span className="transform group-hover:translate-x-1 transition-transform font-mono text-[#3b82f6] dark:text-[#60a5fa]">
                    →
                  </span>
                </button>
              </div>
            </div>

            {/* Product Graphic Frame matching our-products from tunaxa-website */}
            <div className="relative w-full aspect-2/1 sm:aspect-21/9 border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#121820] overflow-hidden mt-10 p-4 sm:p-6 shadow-2xs flex flex-col justify-between">
              <CornerBrackets className="text-black dark:text-white" />
              <div className="flex items-center justify-between font-mono text-[10px] text-neutral-500 uppercase border-b border-[#e5e5e5] dark:border-[#263140] pb-2 mb-2">
                <span className="flex items-center gap-1.5 font-bold text-[#3b82f6]">
                  <PixelIndicator pulseColor="blue" active />/ REAL-TIME
                  PIPELINE TOPOLOGY
                </span>
                <span className="hidden sm:inline">
                  EDGE LATENCY &lt; 20MS // TLS 1.3 // ZERO-KNOWLEDGE
                </span>
              </div>
              <div className="flex-1 flex items-center justify-center relative min-h-[220px] sm:min-h-[300px]">
                <img
                  src="/illustrations/axa-crm-isometric.svg"
                  alt="Tunaxa AXA CRM Pipeline Architecture"
                  className="w-full h-full max-h-[300px] object-contain mx-auto"
                />
              </div>
            </div>
          </div>

          {/* ══════════════════════════════════════════════════════════
              2. QUICK METRICS BAR (4 Columns matching tunaxa-website)
              ══════════════════════════════════════════════════════════ */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
            {METRICS.map((metric, idx) => (
              <div
                key={idx}
                className="relative border border-[#d1d1d1] dark:border-[#263140] bg-[#f7f7f7] dark:bg-[#121820] p-5 md:p-6 transition-all duration-200 hover:shadow-md"
              >
                <CornerBrackets />
                <div className="text-2xl sm:text-3xl md:text-4xl font-extrabold text-black dark:text-white font-mono tracking-tight mb-1">
                  {metric.value}
                </div>
                <div className="text-[11px] font-mono font-bold text-[#2563eb] dark:text-[#3b82f6] tracking-wider uppercase mb-1 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 bg-[#3b82f6] rounded-full" />
                  {metric.label}
                </div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400 font-sans">
                  {metric.detail}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Technical Pixel Divider */}
        <PixelDivider />

        {/* ══════════════════════════════════════════════════════════
            3. INTERACTIVE PIPELINE DEMONSTRATION
            ══════════════════════════════════════════════════════════ */}
        <section id="pipeline" className="space-y-6 scroll-mt-28">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <PixelIndicator pulseColor="blue" active />
                <span className="font-mono text-xs font-semibold uppercase tracking-wider text-[#3b82f6]">
                  / INTERACTIVE PIPELINE ENGINE
                </span>
              </div>
              <h2 className="text-2xl md:text-3xl font-extrabold uppercase font-sans text-black dark:text-white">
                LIVE DEAL DESK SIMULATION
              </h2>
            </div>
            <button
              onClick={onNavigateToDemo}
              className="inline-flex items-center gap-2 px-4 py-2 border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#121820] text-xs font-mono font-bold uppercase tracking-wider hover:border-[#3b82f6] text-black dark:text-white transition-colors cursor-pointer"
            >
              <span>OPEN FULL SALES LAB</span>
              <span className="text-[#3b82f6]">→</span>
            </button>
          </div>

          <div className="border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#0f1217] p-4 sm:p-6 relative shadow-xs">
            <CornerBrackets />
            <InteractivePipelineDemo />
          </div>
        </section>

        {/* Technical Pixel Divider */}
        <PixelDivider />

        {/* ══════════════════════════════════════════════════════════
            4. PRODUCT CAPABILITIES (Matching our-products Cards)
            ══════════════════════════════════════════════════════════ */}
        <section id="features" className="space-y-8 scroll-mt-28">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <PixelIndicator pulseColor="blue" active />
              <span className="font-mono text-xs font-semibold uppercase tracking-wider text-[#3b82f6]">
                / ARCHITECTURE &amp; CAPABILITIES
              </span>
            </div>
            <h2 className="text-2xl md:text-3xl font-extrabold uppercase font-sans text-black dark:text-white">
              ENGINEERED FOR HIGH-CONVERTING SALES TEAMS
            </h2>
            <p className="text-sm text-neutral-500 font-mono mt-1">
              Built to replace fragmented CRMs with a unified, transparent
              operational stack
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 lg:gap-8">
            {CAPABILITIES.map((cap, idx) => (
              <div
                key={idx}
                className="border border-[#d1d1d1] dark:border-[#263140] bg-[#f7f7f7] dark:bg-[#0f1217] relative p-6 md:p-8 flex flex-col justify-between transition-all duration-300 hover:shadow-lg"
              >
                <CornerBrackets />

                <div>
                  {/* Category Tag */}
                  <div className="flex items-center gap-2 mb-4">
                    <PixelIndicator pulseColor="blue" active />
                    <span className="font-mono text-xs font-semibold tracking-wider text-[#3b82f6] uppercase">
                      {cap.tag}
                    </span>
                  </div>

                  {/* Icon Box */}
                  <div className="w-10 h-10 border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#121820] flex items-center justify-center mb-4">
                    {cap.icon}
                  </div>

                  {/* Title */}
                  <h3 className="text-xl font-bold uppercase font-sans text-black dark:text-white mb-1">
                    {cap.title}
                  </h3>

                  {/* Subtitle */}
                  <p className="text-xs font-mono text-neutral-500 mb-3">
                    {cap.subtitle}
                  </p>

                  {/* Description */}
                  <p className="text-sm text-neutral-600 dark:text-neutral-400 font-light leading-relaxed mb-6">
                    {cap.description}
                  </p>

                  {/* Feature Checklist Box */}
                  <div className="relative border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#121820] p-4 mb-4">
                    <CornerBrackets className="text-neutral-400" />
                    <div className="space-y-2.5">
                      {cap.features.map((feat, fIdx) => (
                        <div
                          key={fIdx}
                          className="flex items-start gap-2.5 text-xs text-neutral-700 dark:text-neutral-300 font-sans"
                        >
                          <div className="w-4 h-4 shrink-0 rounded-xs bg-[#eff6ff] dark:bg-[#172554] border border-[#bfdbfe] dark:border-[#1e3a8a] flex items-center justify-center text-[#2563eb] dark:text-[#60a5fa] mt-0.5">
                            <Check className="w-3 h-3 stroke-[2.5]" />
                          </div>
                          <span>{feat}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="pt-2 border-t border-[#e5e5e5] dark:border-[#263140] flex items-center justify-between text-xs font-mono">
                  <span className="text-neutral-400">
                    STATUS: PRODUCTION READY
                  </span>
                  <span className="text-[#3b82f6]">●</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Technical Pixel Divider */}
        <PixelDivider />

        {/* ══════════════════════════════════════════════════════════
            5. CONNECTED TUNAXA ECOSYSTEM SECTION
            ══════════════════════════════════════════════════════════ */}
        <section
          id="ecosystem"
          className="relative border border-[#d1d1d1] dark:border-[#263140] bg-[#f7f7f7] dark:bg-[#0f1217] p-8 md:p-14 scroll-mt-28"
        >
          <CornerBrackets />
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
            <div className="lg:col-span-7 space-y-6">
              <div className="inline-flex items-center gap-2 px-3 py-1.5 border border-[#bfdbfe] dark:border-[#1e3a8a] bg-[#eff6ff] dark:bg-[#172554] text-[#2563eb] dark:text-[#60a5fa] text-xs font-mono font-semibold uppercase tracking-wider">
                <PixelIndicator pulseColor="emerald" active />
                <span>CONNECTED TUNAXA ENTERPRISE SUITE</span>
              </div>
              <h2 className="text-2xl md:text-4xl font-extrabold uppercase font-sans text-black dark:text-white leading-tight">
                NATIVE SUITE TELEMETRY. <br />
                <span className="text-[#3b82f6]">
                  ONE ECOSYSTEM, ZERO SILLOS.
                </span>
              </h2>
              <p className="text-base text-neutral-600 dark:text-neutral-300 font-light leading-relaxed">
                AXA CRM links directly with AXA PASS for encrypted client
                credential management, AXA WORKSPACE for team collaboration
                channels, and AXA SIGN for 1-click legal contract execution
                directly from deal records.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                <div className="border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#121820] p-4 relative">
                  <CornerBrackets className="text-neutral-400" />
                  <span className="font-mono text-xs font-bold text-[#3b82f6] block mb-1">
                    AXA PASS INTEGRATION
                  </span>
                  <p className="text-xs text-neutral-500 font-sans">
                    Zero-knowledge encrypted client secrets and portal API keys
                    linked directly to active deal records.
                  </p>
                </div>
                <div className="border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#121820] p-4 relative">
                  <CornerBrackets className="text-neutral-400" />
                  <span className="font-mono text-xs font-bold text-[#3b82f6] block mb-1">
                    50% ECOSYSTEM DISCOUNT
                  </span>
                  <p className="text-xs text-neutral-500 font-sans">
                    Automatic 50% discount on all CRM tiers if your team uses
                    AXA PASS or any active Tunaxa product.
                  </p>
                </div>
              </div>
            </div>
            <div className="lg:col-span-5 relative border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#121820] p-4 flex flex-col items-center justify-center">
              <CornerBrackets className="text-black dark:text-white" />
              <div className="w-full flex items-center justify-between font-mono text-[10px] text-neutral-500 uppercase border-b border-[#e5e5e5] dark:border-[#263140] pb-2 mb-4">
                <span>TUNAXA ZERO-TRUST TOPOLOGY</span>
                <span className="text-[#f43f5e]">7 APPS</span>
              </div>
              <img
                src="/illustrations/tunaxa-ecosystem-isometric.svg"
                alt="Tunaxa Ecosystem Suite"
                className="w-full h-auto max-h-[280px] object-contain"
              />
            </div>
          </div>
        </section>

        {/* Technical Pixel Divider */}
        <PixelDivider />

        {/* ══════════════════════════════════════════════════════════
            6. TCO / ROI COMPARISON CALCULATOR (Salesforce vs AXA)
            ══════════════════════════════════════════════════════════ */}
        <section id="calculator" className="space-y-6 scroll-mt-28">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <PixelIndicator pulseColor="blue" active />
              <span className="font-mono text-xs font-semibold uppercase tracking-wider text-[#3b82f6]">
                / TOTAL COST OF OWNERSHIP CALCULATOR
              </span>
            </div>
            <h2 className="text-2xl md:text-3xl font-extrabold uppercase font-sans text-black dark:text-white">
              ELIMINATE THE VENDOR SEAT TAX
            </h2>
            <p className="text-sm text-neutral-500 font-mono mt-1">
              Calculate your exact organizational savings compared to legacy
              enterprise platforms
            </p>
          </div>

          <div className="border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#0f1217] p-6 md:p-10 relative">
            <CornerBrackets />

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
              {/* Controls Left */}
              <div className="lg:col-span-6 space-y-6">
                <div>
                  <label className="block font-mono text-xs font-bold uppercase tracking-wider text-black dark:text-white mb-2">
                    SELECT VENDOR TO COMPARE:
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {(["salesforce", "hubspot", "pipedrive"] as const).map(
                      (comp) => (
                        <button
                          key={comp}
                          onClick={() => setCompetitorType(comp)}
                          className={`py-2 px-3 border text-xs font-mono font-bold uppercase transition-all cursor-pointer ${
                            competitorType === comp
                              ? "border-[#3b82f6] bg-[#3b82f6] text-white"
                              : "border-[#d1d1d1] dark:border-[#263140] bg-[#f7f7f7] dark:bg-[#121820] text-neutral-700 dark:text-neutral-300"
                          }`}
                        >
                          {comp}
                        </button>
                      ),
                    )}
                  </div>
                </div>

                <div>
                  <div className="flex justify-between items-center mb-2 font-mono text-xs">
                    <span className="font-bold uppercase text-black dark:text-white">
                      SALES REPS &amp; TEAM SEATS:
                    </span>
                    <span className="font-bold text-[#3b82f6] text-sm">
                      {calculatorSeats} SEATS
                    </span>
                  </div>
                  <input
                    type="range"
                    min="5"
                    max="100"
                    step="5"
                    value={calculatorSeats}
                    onChange={(e) => setCalculatorSeats(Number(e.target.value))}
                    className="w-full h-2 bg-neutral-200 dark:bg-neutral-800 rounded-none accent-[#3b82f6] cursor-pointer"
                  />
                  <div className="flex justify-between font-mono text-[10px] text-neutral-400 mt-1">
                    <span>5 SEATS</span>
                    <span>50 SEATS</span>
                    <span>100 SEATS</span>
                  </div>
                </div>

                {/* Ecosystem discount checkbox */}
                <div className="border border-[#d1d1d1] dark:border-[#263140] bg-[#f7f7f7] dark:bg-[#121820] p-4 flex items-center justify-between">
                  <div>
                    <span className="font-mono text-xs font-bold block text-black dark:text-white uppercase">
                      TUNAXA ECOSYSTEM PASS BUNDLE
                    </span>
                    <span className="text-[11px] text-neutral-500 font-sans">
                      Apply active 50% discount across all CRM seats
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setHasPassDiscount(!hasPassDiscount)}
                    className={`px-3 py-1.5 border text-xs font-mono font-bold uppercase transition-colors cursor-pointer ${
                      hasPassDiscount
                        ? "border-emerald-500 bg-emerald-500 text-white"
                        : "border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#0f1217] text-neutral-600 dark:text-neutral-400"
                    }`}
                  >
                    {hasPassDiscount ? "50% APPLIED" : "ACTIVATE"}
                  </button>
                </div>
              </div>

              {/* Output Right */}
              <div className="lg:col-span-6 border border-[#d1d1d1] dark:border-[#263140] bg-[#f7f7f7] dark:bg-[#121820] p-6 relative">
                <CornerBrackets className="text-[#3b82f6]" />

                <div className="space-y-4">
                  <div className="flex justify-between items-baseline border-b border-[#d1d1d1] dark:border-[#263140] pb-3">
                    <span className="font-mono text-xs text-neutral-500 uppercase">
                      {selectedCompetitor.name}
                    </span>
                    <span className="font-mono text-base font-bold text-red-500">
                      ${monthlyCompetitorCost.toLocaleString()}/mo
                    </span>
                  </div>

                  <div className="flex justify-between items-baseline border-b border-[#d1d1d1] dark:border-[#263140] pb-3">
                    <span className="font-mono text-xs text-neutral-500 uppercase">
                      TUNAXA AXA CRM SUITE
                    </span>
                    <span className="font-mono text-base font-bold text-emerald-500">
                      ${monthlyAxaCost.toLocaleString()}/mo
                    </span>
                  </div>

                  <div className="pt-2">
                    <div className="font-mono text-xs text-neutral-500 uppercase mb-1">
                      ESTIMATED 3-YEAR SAVINGS
                    </div>
                    <div className="text-3xl sm:text-4xl font-extrabold font-mono text-[#3b82f6]">
                      ${threeYearSavings.toLocaleString()}
                    </div>
                    <p className="text-xs font-mono text-emerald-600 dark:text-emerald-400 mt-1">
                      You retain {savingsPercent}% of your operational budget
                    </p>
                  </div>

                  <div className="pt-3">
                    <button
                      onClick={handleLaunchWorkspace}
                      className="w-full py-3 border border-black bg-black text-white dark:bg-white dark:text-black dark:border-white font-mono text-xs font-bold uppercase tracking-wider hover:bg-neutral-800 dark:hover:bg-neutral-200 transition-colors cursor-pointer"
                    >
                      SWITCH &amp; CLAIM SAVINGS →
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Technical Pixel Divider */}
        <PixelDivider />

        {/* ══════════════════════════════════════════════════════════
            7. FREQUENTLY ASKED QUESTIONS (Accordion with CornerBrackets)
            ══════════════════════════════════════════════════════════ */}
        <section id="faq" className="space-y-6 scroll-mt-28">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <PixelIndicator pulseColor="blue" active />
              <span className="font-mono text-xs font-semibold uppercase tracking-wider text-[#3b82f6]">
                / ARCHITECTURAL &amp; BILLING CLARIFICATIONS
              </span>
            </div>
            <h2 className="text-2xl md:text-3xl font-extrabold uppercase font-sans text-black dark:text-white">
              FREQUENTLY ASKED QUESTIONS
            </h2>
          </div>

          <div className="space-y-3">
            {FAQS.map((faq, idx) => {
              const isOpen = openFaqIndex === idx;
              return (
                <div
                  key={idx}
                  className="border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#0f1217] relative transition-all"
                >
                  <CornerBrackets className="text-neutral-400" />
                  <button
                    onClick={() => setOpenFaqIndex(isOpen ? null : idx)}
                    className="w-full px-5 py-4 flex items-center justify-between text-left cursor-pointer bg-transparent border-none"
                  >
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-xs font-bold text-[#3b82f6]">
                        [0{idx + 1}]
                      </span>
                      <span className="font-mono text-xs sm:text-sm font-bold uppercase text-black dark:text-white">
                        {faq.q}
                      </span>
                    </div>
                    <span className="font-mono text-xs text-neutral-400 ml-4">
                      {isOpen ? "[-]" : "[+]"}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="px-5 pb-5 pt-1 border-t border-[#e5e5e5] dark:border-[#263140] font-sans text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed font-light">
                      {faq.a}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* Technical Pixel Divider */}
        <PixelDivider />

        {/* ══════════════════════════════════════════════════════════
            8. FOOTER (Matching tunaxa-website Footer)
            ══════════════════════════════════════════════════════════ */}
        <footer className="mt-16 border border-[#d1d1d1] dark:border-[#263140] bg-[#f7f7f7] dark:bg-[#0f1217] relative">
          <CornerBrackets />

          <div className="p-8 md:p-14 grid grid-cols-1 md:grid-cols-12 gap-10 border-b border-[#d1d1d1] dark:border-[#263140]">
            {/* Left: Brand + Tagline + Socials */}
            <div className="md:col-span-5 flex flex-col justify-between">
              <div>
                <div className="mb-4">
                  <AxacrmLogo size="md" showTunaxaPrefix={true} />
                </div>
                <p className="text-sm font-mono text-neutral-500 mb-6">
                  Execution. Value. Obsession. Learning. Trust.
                </p>
                <div className="inline-flex items-center gap-2 px-3 py-1 border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#121820] font-mono text-[10px] text-neutral-500">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  <span>ALL CRM &amp; PIPELINE SYSTEMS OPERATIONAL</span>
                </div>
              </div>

              <div className="flex items-center gap-3 pt-6">
                <a
                  href="https://www.linkedin.com/company/evolt-dev/"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="LinkedIn"
                  className="relative w-10 h-10 border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#121820] flex items-center justify-center p-2 transition-colors hover:border-[#3b82f6]"
                >
                  <CornerBrackets className="text-neutral-400" />
                  <span className="font-mono text-xs font-bold">IN</span>
                </a>
                <a
                  href="https://x.com/evolt123"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="X / Twitter"
                  className="relative w-10 h-10 border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#121820] flex items-center justify-center p-2 transition-colors hover:border-[#3b82f6]"
                >
                  <CornerBrackets className="text-neutral-400" />
                  <span className="font-mono text-xs font-bold">𝕏</span>
                </a>
                <a
                  href="https://github.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="GitHub"
                  className="relative w-10 h-10 border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#121820] flex items-center justify-center p-2 transition-colors hover:border-[#3b82f6]"
                >
                  <CornerBrackets className="text-neutral-400" />
                  <span className="font-mono text-xs font-bold">GH</span>
                </a>
              </div>
            </div>

            {/* Right: 3 Column Links matching tunaxa-website */}
            <div className="md:col-span-7 grid grid-cols-2 sm:grid-cols-3 gap-8">
              <div>
                <h4 className="font-mono text-xs font-bold text-neutral-900 dark:text-white uppercase tracking-wider mb-4">
                  PLATFORM
                </h4>
                <ul className="space-y-2.5 text-sm text-neutral-600 dark:text-neutral-400 font-sans">
                  <li>
                    <button
                      onClick={onNavigateToPricing}
                      className="hover:text-black dark:hover:text-white hover:underline transition-colors bg-transparent border-none p-0 cursor-pointer text-left"
                    >
                      Pricing &amp; ROI
                    </button>
                  </li>
                  <li>
                    <a
                      href="#pipeline"
                      className="hover:text-black dark:hover:text-white hover:underline transition-colors"
                    >
                      Live Deal Desk
                    </a>
                  </li>
                  <li>
                    <a
                      href="#calculator"
                      className="hover:text-black dark:hover:text-white hover:underline transition-colors"
                    >
                      TCO Calculator
                    </a>
                  </li>
                </ul>
              </div>

              <div>
                <h4 className="font-mono text-xs font-bold text-neutral-900 dark:text-white uppercase tracking-wider mb-4">
                  TUNAXA SUITE
                </h4>
                <ul className="space-y-2.5 text-sm text-neutral-600 dark:text-neutral-400 font-sans">
                  <li>
                    <a
                      href="https://tunaxa.com/our-products#axa-pass"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-black dark:hover:text-white hover:underline transition-colors flex items-center gap-1"
                    >
                      <span>AXA PASS</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </li>
                  <li>
                    <a
                      href="https://tunaxa.com/our-products#axa-workspace"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-black dark:hover:text-white hover:underline transition-colors flex items-center gap-1"
                    >
                      <span>AXA WORKSPACE</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </li>
                  <li>
                    <a
                      href="https://tunaxa.com/our-products#axa-sign"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-black dark:hover:text-white hover:underline transition-colors flex items-center gap-1"
                    >
                      <span>AXA SIGN</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </li>
                  <li>
                    <a
                      href="https://tunaxa.com/our-products#axa-book"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-black dark:hover:text-white hover:underline transition-colors flex items-center gap-1"
                    >
                      <span>AXA BOOK</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </li>
                </ul>
              </div>

              <div>
                <h4 className="font-mono text-xs font-bold text-neutral-900 dark:text-white uppercase tracking-wider mb-4">
                  ACCESS
                </h4>
                <ul className="space-y-2.5 text-sm text-neutral-600 dark:text-neutral-400 font-sans">
                  <li>
                    <button
                      onClick={onNavigateToLogin}
                      className="hover:text-black dark:hover:text-white hover:underline transition-colors bg-transparent border-none p-0 cursor-pointer text-left"
                    >
                      Sign In to CRM
                    </button>
                  </li>
                  <li>
                    <button
                      onClick={handleLaunchWorkspace}
                      className="hover:text-black dark:hover:text-white hover:underline transition-colors bg-transparent border-none p-0 cursor-pointer text-left text-[#3b82f6] font-bold"
                    >
                      Open Free Workspace
                    </button>
                  </li>
                  <li>
                    <a
                      href="https://tunaxa.com"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-black dark:hover:text-white hover:underline transition-colors"
                    >
                      Tunaxa Corporate
                    </a>
                  </li>
                </ul>
              </div>
            </div>
          </div>

          <div className="p-6 md:px-14 flex flex-col sm:flex-row items-center justify-between gap-4 font-mono text-xs text-neutral-500">
            <div>© {new Date().getFullYear()} TUNAXA. ALL RIGHTS RESERVED.</div>
            <div className="flex items-center gap-6">
              <span>ZERO-KNOWLEDGE ARCHITECTURE</span>
              <span>TLS 1.3 ENCRYPTED</span>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
};

export default HomePage;
