import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Icon } from "../../components/Icon";
import {
  Empty,
  PageHeader,
  CornerBrackets,
  money,
} from "../../components/ui";
import { api } from "../../lib/api";

type DashboardRow = {
  kind: string;
  id: string | number;
  route: string;
  icon: string;
  title: string;
  meta: string;
  createdAt: string;
};

type DashboardStats = {
  pipeline?: number;
  won?: number;
  qualified?: number;
  connected?: number;
  leads?: number;
  contacts?: number;
  companies?: number;
  deals?: number;
  tasks?: number;
  recent?: DashboardRow[];
};

export function DashboardPage() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<DashboardStats | null>(null);

  useEffect(() => {
   const load = () => api<DashboardStats>("/dashboard").then(setStats);

    load();

    window.addEventListener("tunaxa:resource-changed", load);

    return () =>
      window.removeEventListener("tunaxa:resource-changed", load);
  }, []);

  const cards = [
    [
      "Pipeline value",
      money(stats?.pipeline || 0),
      "Open deal value",
      "money",
      "blue",
    ],
    [
      "Won revenue",
      money(stats?.won || 0),
      "Closed won",
      "trend",
      "green",
    ],
    [
      "Qualified leads",
      String(stats?.qualified || 0),
      "Ready for pipeline",
      "lead",
      "purple",
    ],
    [
      "Connected calls",
      String(stats?.connected || 0),
      "Logged conversations",
      "phone",
      "amber",
    ],
  ];

  const recent = stats?.recent || [];

  return (
    <div className="page">
      <PageHeader
        title="Dashboard"
        description="A live view of your sales workspace."
      >
        <button
          className="btn primary"
          onClick={() => navigate("/pipeline")}
        >
          <Icon name="pipeline" /> Open pipeline
        </button>
      </PageHeader>

      <div className="stats-grid">
        {cards.map((card) => (
          <div
            className="stat-card hover-crm-card relative"
            key={card[0]}
          >
            <CornerBrackets stroke="#3b82f6" size="sm" />

            <div className={`stat-icon tone-${card[4]}`}>
              <Icon name={card[3]} />
            </div>

            <div>
              <small>{card[0]}</small>
              <strong>{card[1]}</strong>
              <span>{card[2]}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="dashboard-grid">
        <section className="surface revenue-card">
          <div className="section-head">
            <div>
              <h2>Workspace totals</h2>
              <p>Everything saved in your Tunaxa workspace</p>
            </div>

            <button
              className="btn secondary compact"
              onClick={() => navigate("/reports")}
            >
              View reports
            </button>
          </div>

          <div className="record-count-grid">
            {[
              ["Leads", stats?.leads, "lead", "/leads"],
              ["Contacts", stats?.contacts, "contacts", "/contacts"],
              ["Companies", stats?.companies, "companies", "/companies"],
              ["Deals", stats?.deals, "pipeline", "/pipeline"],
              ["Tasks", stats?.tasks, "tasks", "/tasks"],
            ].map(([label, count, icon, path]) => (
              <button
                key={String(label)}
                className="record-count"
                onClick={() => navigate(String(path))}
              >
                <Icon name={String(icon)} />
                <b>{count || 0}</b>
                <span>{label}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="surface activities-widget">
          <div className="section-head">
            <div>
              <h2>Recent activity</h2>
              <p>Latest work across the CRM</p>
            </div>
          </div>

          {recent.length ? (
            <div className="recent-list">
              {recent.slice(0, 6).map((item) => (
                <button
                  key={`${item.kind}-${item.id}`}
                  onClick={() => navigate(item.route)}
                >
                  <span className="recent-icon">
                    <Icon name={item.icon} />
                  </span>

                  <div>
                    <b>{item.title}</b>
                    <small>{item.meta}</small>
                  </div>

                  <time>
                    {new Date(item.createdAt).toLocaleString()}
                  </time>
                </button>
              ))}
            </div>
          ) : (
            <Empty
              icon="activity"
              title="No activity yet"
              text="Your latest calls, tasks and activities will appear here automatically."
              action={
                <button
                  className="btn primary compact"
                  onClick={() => navigate("/leads")}
                >
                  Add a lead
                </button>
              }
            />
          )}
        </section>
      </div>
    </div>
  );
}