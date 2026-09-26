import React, { useState } from "react";
import { Sun, Moon, LayoutGrid, Menu, X, Zap } from "lucide-react";
import { CornerBrackets } from "../ui/CornerBrackets";
import { PixelIndicator } from "../ui/PixelIndicator";
import { AxacrmLogo } from "../common/AxacrmLogo";
import { EcosystemMenu } from "./EcosystemMenu";
import { Link } from "react-router-dom";

interface NavbarProps {
  onNavigateToLogin: () => void;
  onNavigateToPricing?: () => void;
  onNavigateToDemo?: () => void;
  onNavigateToSetup?: () => void;
  activeSection?: string;
}

export const Navbar: React.FC<NavbarProps> = ({
  onNavigateToLogin,
  onNavigateToPricing,
  onNavigateToDemo,
  onNavigateToSetup,
  activeSection,
}) => {
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [isEcosystemOpen, setIsEcosystemOpen] = useState<boolean>(false);
  const [isDark, setIsDark] = useState<boolean>(() =>
    document.documentElement.classList.contains("dark"),
  );

  const toggleTheme = () => {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("tunaxa.theme", next ? "dark" : "light");
  };

  const navLinks = [
    { name: "Features", href: "#features" },
    { name: "Pipeline", href: "#pipeline" },
    { name: "Engines", href: "#engines" },
    { name: "ROI Calculator", href: "#calculator" },
    { name: "Compare", href: "#compare" },
    { name: "Pricing", href: "#pricing", onClick: onNavigateToPricing },
    { name: "FAQ", href: "#faq" },
  ];

  const handleLinkClick = (
    e: React.MouseEvent,
    href: string,
    customClick?: () => void,
  ) => {
    if (customClick) {
      e.preventDefault();
      customClick();
      setIsOpen(false);
      return;
    }
    if (href.startsWith("#")) {
      e.preventDefault();
      const id = href.substring(1);
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: "smooth" });
      }
      setIsOpen(false);
    }
  };

  const handleLaunch = onNavigateToSetup || onNavigateToLogin;

  return (
    <>
      <header className="fixed top-0 left-0 right-0 z-40 px-3 sm:px-6 md:px-8 pt-2 select-none w-full">
        <div className="relative mx-auto w-full border border-[#d1d1d1] dark:border-[#263140] bg-white/95 dark:bg-[#0d1117]/95 backdrop-blur-md transition-all duration-200 shadow-md">
          <CornerBrackets />

          <nav className="px-3 py-2.5 sm:px-5 sm:py-3">
            <div className="flex items-center justify-between gap-4">
              {/* Brand Logo matching Tunaxa Design System */}
              <button
                onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
                className="group flex items-center gap-2.5 bg-transparent border-0 p-0 text-left cursor-pointer"
                title="Tunaxa AXA CRM"
              >
                <AxacrmLogo size="sm" showTunaxaPrefix={true} />
              </button>

              {/* Desktop Navigation Links with Tunaxa Hover PixelIndicator & Active Blue Line */}
              <div className="hidden md:flex items-center gap-6 lg:gap-8 font-mono text-xs uppercase tracking-wider">
                {navLinks.map((link) => {
                  const isActive = activeSection === link.href.replace("#", "");
                  return (
                    <Link
                      key={link.name}
                      to={link.href}
                      onClick={(e) =>
                        handleLinkClick(e, link.href, link.onClick)
                      }
                      className={`group relative flex items-center py-1 font-medium transition-colors ${
                        isActive
                          ? "text-black dark:text-white font-bold"
                          : "text-neutral-600 dark:text-neutral-400 hover:text-black dark:hover:text-white"
                      }`}
                    >
                      {/* Pixel Indicator with Hover Slide-in Effect */}
                      <span
                        className={`overflow-hidden transition-all duration-200 flex items-center ${
                          isActive
                            ? "w-4 opacity-100 mr-1.5"
                            : "w-0 opacity-0 group-hover:w-4 group-hover:opacity-100 group-hover:mr-1.5"
                        }`}
                      >
                        <PixelIndicator pulseColor="blue" active />
                      </span>

                      <span>{link.name}</span>

                      {/* Bottom Blue Active/Hover Line */}
                      <span
                        className={`absolute bottom-0 left-0 h-0.5 bg-[#3b82f6] transition-all duration-200 ${
                          isActive ? "w-full" : "w-0 group-hover:w-full"
                        }`}
                      />
                    </Link>
                  );
                })}
              </div>

              {/* Action Buttons Right */}
              <div className="flex items-center gap-2 sm:gap-3">
                {/* Ecosystem App Switcher Button (9-Dots Waffle Menu) */}
                <button
                  onClick={() => setIsEcosystemOpen(true)}
                  title="Tunaxa Ecosystem Apps"
                  className="p-2 border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#121820] text-neutral-600 dark:text-neutral-400 hover:text-[#3b82f6] dark:hover:text-white hover:border-[#3b82f6] transition-colors flex items-center justify-center cursor-pointer"
                  aria-label="Tunaxa Ecosystem Apps"
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                </button>

                {/* Theme Mode Toggle */}
                <button
                  onClick={toggleTheme}
                  title={
                    isDark
                      ? "Switch to Light Blueprint"
                      : "Switch to Dark Cyber"
                  }
                  className="p-2 border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#121820] text-neutral-600 dark:text-neutral-400 hover:text-black dark:hover:text-white transition-colors cursor-pointer"
                >
                  {isDark ? (
                    <Sun className="w-3.5 h-3.5" />
                  ) : (
                    <Moon className="w-3.5 h-3.5" />
                  )}
                </button>

                {/* Sign In Link */}
                <button
                  onClick={onNavigateToLogin}
                  className="hidden sm:inline-block px-2 sm:px-3 py-1.5 text-xs font-mono font-medium uppercase tracking-wider text-neutral-600 hover:text-black dark:text-neutral-400 dark:hover:text-white transition-colors cursor-pointer"
                >
                  SIGN IN
                </button>

                {/* Primary CTA Chamfered Cut-Corner Button matching Tunaxa Signature Style */}
                <button
                  onClick={handleLaunch}
                  className="group relative inline-flex items-center justify-between gap-2.5 px-4 py-2 border border-black bg-black text-white dark:bg-white dark:text-black dark:border-white text-xs font-mono font-semibold uppercase tracking-wider transition-all duration-200 hover:bg-neutral-800 dark:hover:bg-neutral-200 cursor-pointer"
                  style={{
                    clipPath:
                      "polygon(6px 0%, 100% 0%, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0% 100%, 0% 6px)",
                  }}
                >
                  <div className="flex items-center gap-1.5">
                    <PixelIndicator pulseColor="blue" active />
                    <span>OPEN WORKSPACE</span>
                  </div>
                  <span className="transform group-hover:translate-x-0.5 transition-transform duration-200 text-[#3b82f6] font-mono">
                    →
                  </span>
                </button>

                {/* Mobile Hamburger Toggle Button */}
                <button
                  type="button"
                  onClick={() => setIsOpen(!isOpen)}
                  className="md:hidden p-2 border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#121820] text-black dark:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors focus:outline-none cursor-pointer"
                  aria-label="Toggle navigation menu"
                >
                  {isOpen ? (
                    <X className="w-4 h-4" />
                  ) : (
                    <Menu className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>

            {/* Mobile Dropdown Menu */}
            {isOpen && (
              <div className="lg:hidden mt-3 pt-3 border-t border-[#d1d1d1] dark:border-[#263140] flex flex-col gap-2 font-mono text-xs tracking-wider uppercase animate-fade-in">
                {navLinks.map((link) => (
                  <Link
                    key={link.name}
                    to={link.href}
                    onClick={(e) => handleLinkClick(e, link.href, link.onClick)}
                    className="flex items-center justify-between py-2 px-3 border border-[#e5e5e5] dark:border-[#1e2632] bg-[#f7f7f7] dark:bg-[#161b22] text-neutral-700 dark:text-neutral-200 hover:border-[#3b82f6] transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <PixelIndicator pulseColor="blue" active />
                      <span>{link.name}</span>
                    </div>
                    <span className="text-[#3b82f6]">→</span>
                  </Link>
                ))}

                <div className="grid grid-cols-2 gap-2 pt-2">
                  {onNavigateToDemo && (
                    <button
                      onClick={() => {
                        setIsOpen(false);
                        onNavigateToDemo();
                      }}
                      className="flex items-center justify-center gap-1.5 py-2.5 px-3 border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#121820] text-black dark:text-white text-xs font-mono font-semibold uppercase"
                    >
                      <Zap className="w-3.5 h-3.5 text-[#3b82f6]" />
                      <span>Sales Lab</span>
                    </button>
                  )}

                  <button
                    onClick={() => {
                      setIsOpen(false);
                      onNavigateToLogin();
                    }}
                    className="py-2.5 px-3 border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#121820] text-black dark:text-white text-xs font-mono font-semibold uppercase text-center"
                  >
                    Sign In
                  </button>
                </div>

                <div className="pt-1">
                  <button
                    onClick={() => {
                      setIsOpen(false);
                      handleLaunch();
                    }}
                    className="group relative flex items-center justify-between px-4 py-3 border border-black bg-black text-white dark:bg-white dark:text-black dark:border-white text-xs font-mono font-semibold uppercase tracking-wider w-full"
                    style={{
                      clipPath:
                        "polygon(6px 0%, 100% 0%, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0% 100%, 0% 6px)",
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <PixelIndicator pulseColor="blue" active />
                      <span>Launch CRM Workspace</span>
                    </div>
                    <span className="text-[#3b82f6] font-mono">→</span>
                  </button>
                </div>
              </div>
            )}
          </nav>
        </div>
      </header>

      {/* Ecosystem Apps Switcher Modal */}
      <EcosystemMenu
        isOpen={isEcosystemOpen}
        onClose={() => setIsEcosystemOpen(false)}
      />
    </>
  );
};

export default Navbar;
