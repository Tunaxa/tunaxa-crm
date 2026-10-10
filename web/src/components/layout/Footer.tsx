import React from "react";
import { ExternalLink } from "lucide-react";
import { CornerBrackets } from "../ui";
import { AxacrmLogo } from "../components/../common/AxacrmLogo";

interface FooterProps {
  onNavigateToHome?: () => void;
  onNavigateToPricing?: () => void;
  onNavigateToDemo?: () => void;
  onNavigateToLogin?: () => void;
  onNavigateToSetup?: () => void;
  className?: string;
}

export const Footer: React.FC<FooterProps> = ({
  onNavigateToHome,
  onNavigateToPricing,
  onNavigateToLogin,
  onNavigateToSetup,
  className = "",
}) => {
  return (
    <footer
      className={`mt-16 border border-[#d1d1d1] dark:border-[#263140] bg-[#f7f7f7] dark:bg-[#0f1217] relative ${className}`}
    >
      <CornerBrackets stroke="#3b82f6" size={8} />

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
              href="https://www.linkedin.com/company/tunaxa/"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="LinkedIn"
              className="relative w-10 h-10 border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#121820] flex items-center justify-center p-2 transition-colors hover:border-[#3b82f6]"
            >
              <CornerBrackets className="text-neutral-400" size={4} />
              <img
                src="https://img.icons8.com/?size=100&id=wybRSjTxfYz3&format=png&color=000000"
                alt="LinkedIn"
                width={22}
                height={22}
                className="object-contain"
              />
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
                  onClick={onNavigateToPricing || onNavigateToHome}
                  className="hover:text-black dark:hover:text-white hover:underline transition-colors bg-transparent border-none p-0 cursor-pointer text-left font-sans text-neutral-600 dark:text-neutral-400 text-sm"
                >
                  Pricing &amp; ROI
                </button>
              </li>
              <li>
                <button
                  onClick={onNavigateToHome}
                  className="hover:text-black dark:hover:text-white hover:underline transition-colors bg-transparent border-none p-0 cursor-pointer text-left font-sans text-neutral-600 dark:text-neutral-400 text-sm"
                >
                  Live Deal Desk
                </button>
              </li>
              <li>
                <button
                  onClick={onNavigateToPricing || onNavigateToHome}
                  className="hover:text-black dark:hover:text-white hover:underline transition-colors bg-transparent border-none p-0 cursor-pointer text-left font-sans text-neutral-600 dark:text-neutral-400 text-sm"
                >
                  TCO Calculator
                </button>
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
                  className="hover:text-black dark:hover:text-white hover:underline transition-colors flex items-center gap-1 text-neutral-600 dark:text-neutral-400"
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
                  className="hover:text-black dark:hover:text-white hover:underline transition-colors flex items-center gap-1 text-neutral-600 dark:text-neutral-400"
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
                  className="hover:text-black dark:hover:text-white hover:underline transition-colors flex items-center gap-1 text-neutral-600 dark:text-neutral-400"
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
                  className="hover:text-black dark:hover:text-white hover:underline transition-colors flex items-center gap-1 text-neutral-600 dark:text-neutral-400"
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
                  onClick={onNavigateToLogin || onNavigateToHome}
                  className="hover:text-black dark:hover:text-white hover:underline transition-colors bg-transparent border-none p-0 cursor-pointer text-left font-sans text-neutral-600 dark:text-neutral-400 text-sm"
                >
                  Sign In to CRM
                </button>
              </li>
              <li>
                <button
                  onClick={
                    onNavigateToSetup || onNavigateToLogin || onNavigateToHome
                  }
                  className="hover:text-black dark:hover:text-white hover:underline transition-colors bg-transparent border-none p-0 cursor-pointer text-left text-[#3b82f6] font-bold font-sans text-sm"
                >
                  Open Free Workspace
                </button>
              </li>
              <li>
                <a
                  href="https://tunaxa.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-black dark:hover:text-white hover:underline transition-colors text-neutral-600 dark:text-neutral-400"
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
  );
};
