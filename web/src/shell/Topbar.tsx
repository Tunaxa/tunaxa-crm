import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { LayoutGrid, Moon, Sun } from "lucide-react";
import { Icon } from "../components/Icon";
import { Avatar, CornerBrackets, CutButton } from "../components/ui";
import { useApp } from "../context/AppContext";
import i18n from "../i18n";
import { titles } from "./navGroups";

export function Topbar({
  onOpenMobile,
  onOpenSearch,
  onOpenQuickCreate,
  onOpenEcosystem,
  profile,
  onToggleProfile,
  theme,
  onToggleTheme,
  onToggleLanguage,
}: {
  mobile: boolean;
  onOpenMobile: () => void;
  onOpenSearch: () => void;
  onOpenQuickCreate: () => void;
  onOpenEcosystem: () => void;
  profile: boolean;
  onToggleProfile: () => void;
  theme: boolean;
  onToggleTheme: () => void;
  onToggleLanguage: () => void;
}) {
  const { user, logout, toast } = useApp();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <header className="topbar topbar-glass">
      <div className="topbar-left">
        <button className="icon-btn mobile-menu" onClick={onOpenMobile} title="Open Navigation"><Icon name="menu" /></button>
        <div className="crumb relative px-3 py-1 border border-[#d1d1d1] dark:border-[#263140] bg-white dark:bg-[#121820]">
          <CornerBrackets stroke="#3b82f6" size={5} />
          <span>{t("nav.workspace")}</span>
          <b>{titles[location.pathname] ? t(titles[location.pathname]) : "Tunaxa"}</b>
        </div>
      </div>
      <div className="topbar-right">
        <button className="search-button" onClick={onOpenSearch}><Icon name="search" /><span>Search everything…</span><kbd>Ctrl K</kbd></button>
        <CutButton variant="primary" size="sm" onClick={onOpenQuickCreate}><div className="flex items-center gap-1.5 font-mono text-xs"><Icon name="plus" /><span>NEW</span></div></CutButton>
        <button className="icon-btn" onClick={onOpenEcosystem} title="Tunaxa Ecosystem Apps" aria-label="Tunaxa Ecosystem Apps"><LayoutGrid className="w-4 h-4 text-[#3b82f6]" /></button>
        <button className="icon-btn" onClick={onToggleTheme} title={theme ? "Light Blueprint" : "Dark Cyber"}>{theme ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}</button>
        <button className="icon-btn notification-btn" onClick={() => toast("No new notifications")} title="Notifications"><Icon name="bell" /></button>
        <div className="profile-wrap">
          <button className="profile-trigger" onClick={onToggleProfile}><Avatar name={user?.name || "TX"} /><div><b>{user?.name}</b><small>{user?.role}</small></div><Icon name="chevronDown" /></button>
          {profile ? <div className="profile-menu">
            <div className="profile-menu-head"><Avatar name={user?.name || "TX"} size={38} /><div><b>{user?.name}</b><small>{user?.email}</small></div></div>
            <button onClick={() => navigate("/settings")}><Icon name="settings" /> {t("nav.settings")}</button>
            <button onClick={onToggleLanguage}><Icon name="globe" /> {(i18n.language || "en") === "fr" ? "English" : "Français"}</button>
            <button onClick={onToggleTheme}>{theme ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />} {theme ? "Light Blueprint" : "Dark Cyber"}</button>
            <hr /><button className="danger-link" onClick={logout}><Icon name="logout" /> Sign out</button>
          </div> : null}
        </div>
      </div>
    </header>
  );
}