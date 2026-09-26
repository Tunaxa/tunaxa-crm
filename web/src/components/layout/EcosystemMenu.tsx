import React, { useEffect, useRef } from 'react';
import {
  X,
  ExternalLink,
  Shield,
  Users,
  Briefcase,
  FileCheck,
  Calendar,
  Globe,
  BookOpen,
  Sparkles,
} from 'lucide-react';
import { CornerBrackets } from '../ui/CornerBrackets';
import { PixelIndicator } from '../ui/PixelIndicator';

export interface EcosystemApp {
  id: string;
  name: string;
  category: string;
  description: string;
  href: string;
  icon: React.ReactNode;
  badge?: string;
  isCurrent?: boolean;
}

const ECOSYSTEM_APPS: EcosystemApp[] = [
  {
    id: 'axa-crm',
    name: 'AXA CRM',
    category: '/ SALES & PIPELINES',
    description: 'Intelligent sales pipeline, contact tracking & deal automation',
    href: '#',
    icon: <Users className="w-5 h-5 text-[#3b82f6]" />,
    badge: 'CURRENT APP',
    isCurrent: true,
  },
  {
    id: 'axa-pass',
    name: 'AXA PASS',
    category: '/ CREDENTIAL SECURITY',
    description: 'Zero-knowledge encrypted password vault & secrets manager',
    href: 'https://tunaxa.com/our-products#axa-pass',
    icon: <Shield className="w-5 h-5 text-emerald-500" />,
    badge: '50% ECOSYSTEM OFF',
  },
  {
    id: 'axa-workspace',
    name: 'AXA WORKSPACE',
    category: '/ COLLABORATION',
    description: 'Central team command center with docs, chat, and cloud storage',
    href: 'https://tunaxa.com/our-products#axa-workspace',
    icon: <Briefcase className="w-5 h-5 text-indigo-500" />,
  },
  {
    id: 'axa-sign',
    name: 'AXA SIGN',
    category: '/ DIGITAL CONTRACTS',
    description: 'Audit-trailed digital signatures and legal agreement templates',
    href: 'https://tunaxa.com/our-products#axa-sign',
    icon: <FileCheck className="w-5 h-5 text-violet-500" />,
  },
  {
    id: 'axa-book',
    name: 'AXA BOOK',
    category: '/ SCHEDULING',
    description: 'Automated 2-way calendar booking links & intake forms',
    href: 'https://tunaxa.com/our-products#axa-book',
    icon: <Calendar className="w-5 h-5 text-amber-500" />,
  },
  {
    id: 'tunaxa-website',
    name: 'TUNAXA PORTAL',
    category: '/ PLATFORM',
    description: 'Explore the full Tunaxa suite, architecture & ecosystem pricing',
    href: 'https://tunaxa.com',
    icon: <Globe className="w-5 h-5 text-sky-500" />,
  },
  {
    id: 'tunaxa-docs',
    name: 'TUNAXA DOCS',
    category: '/ DEVELOPERS',
    description: 'Zero-knowledge crypto specifications, APIs & developer guides',
    href: 'https://tunaxa.com/docs',
    icon: <BookOpen className="w-5 h-5 text-neutral-500 dark:text-neutral-300" />,
  },
];

interface EcosystemMenuProps {
  isOpen: boolean;
  onClose: () => void;
}

export const EcosystemMenu: React.FC<EcosystemMenuProps> = ({ isOpen, onClose }) => {
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-start justify-center pt-14 sm:pt-18 p-3 sm:p-4 bg-black/60 backdrop-blur-xs select-none cursor-pointer animate-fade-in"
    >
      <div
        ref={modalRef}
        className="relative w-full max-w-2xl border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#121820] shadow-2xl flex flex-col max-h-[85vh] cursor-default"
      >
        <CornerBrackets />

        {/* Ecosystem Modal Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#d1d1d1] dark:border-[#263140] bg-[#f7f7f7] dark:bg-[#161b22]">
          <div className="flex items-center gap-2.5">
            <PixelIndicator pulseColor="blue" active />
            <div>
              <div className="font-mono text-xs font-bold uppercase tracking-wider text-black dark:text-white flex items-center gap-2">
                <span>TUNAXA ECOSYSTEM APPS</span>
                <span className="text-[10px] px-1.5 py-0.2 bg-[#eff6ff] dark:bg-[#1e293b] text-[#3b82f6] border border-[#bfdbfe] dark:border-[#1d4ed8]">
                  UNIFIED SUITE
                </span>
              </div>
              <p className="font-mono text-[11px] text-neutral-500 mt-0.5">
                Switch seamlessly between connected Tunaxa enterprise tools
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            title="Close (Esc)"
            className="p-1.5 border border-[#d1d1d1] dark:border-[#30363d] bg-white dark:bg-[#121820] text-neutral-500 hover:text-black dark:hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Apps Grid */}
        <div className="overflow-y-auto p-4 sm:p-5 grid grid-cols-1 sm:grid-cols-2 gap-3.5 flex-1">
          {ECOSYSTEM_APPS.map((app) => (
            <a
              key={app.id}
              href={app.href}
              target={app.isCurrent ? undefined : '_blank'}
              rel={app.isCurrent ? undefined : 'noopener noreferrer'}
              onClick={(e) => {
                if (app.isCurrent) {
                  e.preventDefault();
                  onClose();
                }
              }}
              className={`group relative border p-4 transition-all duration-150 flex flex-col justify-between ${
                app.isCurrent
                  ? 'border-[#3b82f6] bg-[#eff6ff]/30 dark:bg-[#1e3a8a]/10 cursor-default'
                  : 'border-[#d1d1d1] dark:border-[#263140] bg-[#fafafa] dark:bg-[#0a0e14] hover:border-[#3b82f6] hover:bg-white dark:hover:bg-[#161b22] cursor-pointer'
              }`}
            >
              <CornerBrackets className={app.isCurrent ? 'text-[#3b82f6]' : 'text-neutral-400 group-hover:text-[#3b82f6]'} />

              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#121820] flex items-center justify-center shrink-0">
                      {app.icon}
                    </div>
                    <div>
                      <div className="font-mono text-xs font-bold uppercase tracking-wider text-black dark:text-white flex items-center gap-1.5">
                        <span>{app.name}</span>
                        {!app.isCurrent && (
                          <ExternalLink className="w-3 h-3 text-neutral-400 group-hover:text-[#3b82f6] transition-colors" />
                        )}
                      </div>
                      <div className="font-mono text-[10px] text-[#3b82f6] tracking-wider font-semibold">
                        {app.category}
                      </div>
                    </div>
                  </div>

                  {app.badge && (
                    <span
                      className={`text-[9px] font-mono font-bold px-1.5 py-0.5 border uppercase ${
                        app.isCurrent
                          ? 'border-[#3b82f6] bg-[#3b82f6] text-white'
                          : 'border-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
                      }`}
                    >
                      {app.badge}
                    </span>
                  )}
                </div>

                <p className="font-mono text-[11px] text-neutral-600 dark:text-neutral-400 leading-relaxed mt-2">
                  {app.description}
                </p>
              </div>

              <div className="mt-3 pt-2.5 border-t border-[#e5e5e5] dark:border-[#1e2632] flex items-center justify-between text-[10px] font-mono">
                <span className="text-neutral-400 group-hover:text-neutral-600 dark:group-hover:text-neutral-300">
                  {app.isCurrent ? 'Active in current workspace' : 'Launch application'}
                </span>
                <span className="text-[#3b82f6] group-hover:translate-x-0.5 transition-transform">
                  {app.isCurrent ? '●' : '→'}
                </span>
              </div>
            </a>
          ))}
        </div>

        {/* Footer info note */}
        <div className="px-5 py-3 bg-[#f7f7f7] dark:bg-[#161b22] border-t border-[#d1d1d1] dark:border-[#263140] flex items-center justify-between font-mono text-[11px] text-neutral-500">
          <div className="flex items-center gap-2">
            <Sparkles className="w-3.5 h-3.5 text-[#3b82f6]" />
            <span>Unified Tunaxa identity & enterprise telemetry</span>
          </div>
          <span className="text-[10px] hidden sm:inline text-neutral-400">
            Press ESC to exit
          </span>
        </div>
      </div>
    </div>
  );
};

export default EcosystemMenu;
