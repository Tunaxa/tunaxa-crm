import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { EcosystemMenu } from "../components/layout/EcosystemMenu";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import i18n from "../i18n";

export function Shell({
  children,
  renderQuickCreate,
  renderGlobalSearch,
}: {
  children: ReactNode;
  renderQuickCreate: (onClose: () => void) => ReactNode;
  renderGlobalSearch: (onClose: () => void) => ReactNode;
}) {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(localStorage.getItem("tunaxa.sidebar") === "1");
  const [mobile, setMobile] = useState(false);
  const [profile, setProfile] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [theme, setTheme] = useState(document.documentElement.classList.contains("dark"));
  const [isEcosystemOpen, setIsEcosystemOpen] = useState(false);

  useEffect(() => localStorage.setItem("tunaxa.sidebar", collapsed ? "1" : "0"), [collapsed]);
  useEffect(() => {
    setMobile(false);
    setProfile(false);
  }, [location.pathname]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        setQuickOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  function toggleTheme() {
    const next = !theme;
    setTheme(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("tunaxa.theme", next ? "dark" : "light");
  }

  function toggleLanguage() {
    const current = i18n.language || "en";
    const next = current === "fr" ? "en" : "fr";
    i18n.changeLanguage(next);
    localStorage.setItem("tunaxa.language", next);
  }

  return (
    <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      <div className="blueprint-grid-global" aria-hidden="true" />
      <div className={`mobile-overlay ${mobile ? "show" : ""}`} onClick={() => setMobile(false)} />
      <Sidebar collapsed={collapsed} mobile={mobile} onToggleCollapse={() => setCollapsed((value) => !value)} />
      <section className="workspace">
        <Topbar
          mobile={mobile}
          onOpenMobile={() => setMobile(true)}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenQuickCreate={() => setQuickOpen(true)}
          onOpenEcosystem={() => setIsEcosystemOpen(true)}
          profile={profile}
          onToggleProfile={() => setProfile((value) => !value)}
          theme={theme}
          onToggleTheme={toggleTheme}
          onToggleLanguage={toggleLanguage}
        />
        <main className="content">{children}</main>
      </section>
      {quickOpen ? renderQuickCreate(() => setQuickOpen(false)) : null}
      {searchOpen ? renderGlobalSearch(() => setSearchOpen(false)) : null}
      <EcosystemMenu isOpen={isEcosystemOpen} onClose={() => setIsEcosystemOpen(false)} />
    </div>
  );
}
