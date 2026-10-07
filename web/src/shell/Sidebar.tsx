import { useTranslation } from "react-i18next";
import { useNavigate, NavLink } from "react-router-dom";
import { Icon } from "../components/Icon";
import { AxacrmLogo } from "../components/common/AxacrmLogo";
import { navGroups } from "./navGroups";

export function Sidebar({
  collapsed,
  mobile,
  onToggleCollapse,
}: {
  collapsed: boolean;
  mobile: boolean;
  onToggleCollapse: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <aside className={`sidebar ${mobile ? "mobile-open" : ""}`}>
      <div className="sidebar-logo">
        <button className="brand" onClick={() => navigate("/dashboard")} title="Tunaxa AXA CRM">
          {collapsed ? (
            <div className="w-7 h-7 bg-black text-white dark:bg-white dark:text-black flex items-center justify-center font-mono font-black shrink-0" style={{ clipPath: "polygon(3px 0%, 100% 0%, 100% calc(100% - 3px), calc(100% - 3px) 100%, 0% 100%, 0% 3px)" }}>
              <span className="text-xs">TX</span>
            </div>
          ) : <AxacrmLogo size="sm" showTunaxaPrefix={true} />}
        </button>
        <button className="collapse-btn" onClick={onToggleCollapse} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
          <Icon name="arrowLeft" />
        </button>
      </div>
      <nav className="nav-scroll">
        {navGroups.map((group) => (
          <section className="nav-group" key={group.label}>
            <div className="nav-label">{t(group.label)}</div>
            {group.items.map((item) => (
              <NavLink key={item.path} to={item.path} data-tooltip={t(item.label)} className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
                <Icon name={item.icon} />
                <span>{t(item.label)}</span>
              </NavLink>
            ))}
          </section>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div className="workspace-mini">
          <div className="w-7 h-7 bg-[#3b82f6] text-white flex items-center justify-center font-mono font-bold text-xs shrink-0" style={{ clipPath: "polygon(3px 0%, 100% 0%, 100% calc(100% - 3px), calc(100% - 3px) 100%, 0% 100%, 0% 3px)" }}>
            <span>TX</span>
          </div>
          <div><b>Tunaxa CRM</b><small>Enterprise Workspace</small></div>
        </div>
      </div>
    </aside>
  );
}