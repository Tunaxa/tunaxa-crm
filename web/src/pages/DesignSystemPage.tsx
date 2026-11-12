import { theme } from "../styles/theme";
import { Chamfer } from "../components/ui/Chamfer";
import "../styles/design-system.css";

const colors = [
  ["bg", theme.color.bg],
  ["surface", theme.color.surface],
  ["surface2", theme.color.surface2],
  ["text", theme.color.text],
  ["textMuted", theme.color.textMuted],
  ["textFaint", theme.color.textFaint],
  ["border", theme.color.border],
  ["borderStrong", theme.color.borderStrong],
  ["success", theme.color.success],
  ["danger", theme.color.danger],
  ["warning", theme.color.warning],
] as const;

const spaces = Object.entries(theme.space);
const radii = Object.entries(theme.radius);
const shadows = Object.entries(theme.shadow);

export function DesignSystemPage() {
  return (
    <main className="design-system">
      <header className="design-system__header">
        <p className="design-system__eyebrow">AXACRM</p>
        <h1>Design System</h1>
        <p>
          Neutral v0 — tokens, typography, spacing, radius, shadows and the
          Chamfer primitive.
        </p>
      </header>

      <section className="design-system__section">
        <h2>Colors</h2>

        <div className="design-system__colors">
          {colors.map(([name, value]) => (
            <div className="design-system__color" key={name}>
              <div
                className="design-system__swatch"
                style={{ background: value }}
              />
              <strong>{name}</strong>
              <code>{value}</code>
            </div>
          ))}
        </div>
      </section>

      <section className="design-system__section">
        <h2>Spacing</h2>

        <div className="design-system__spacing">
          {spaces.map(([name, value]) => (
            <div className="design-system__spacing-row" key={name}>
              <code>space-{name}</code>
              <div
                className="design-system__spacing-bar"
                style={{ width: value }}
              />
              <span>{value}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="design-system__section">
        <h2>Radius</h2>

        <div className="design-system__radius">
          {radii.map(([name, value]) => (
            <div
              className="design-system__radius-card"
              key={name}
              style={{ borderRadius: value }}
            >
              <strong>{name}</strong>
              <code>{value}</code>
            </div>
          ))}
        </div>
      </section>

      <section className="design-system__section">
        <h2>Typography</h2>

        <div className="design-system__type">
          <p style={{ fontFamily: theme.font.sans, fontSize: theme.font["3xl"] }}>
            Heading 3xl
          </p>
          <p style={{ fontFamily: theme.font.sans, fontSize: theme.font.xl }}>
            Heading xl
          </p>
          <p style={{ fontFamily: theme.font.sans, fontSize: theme.font.md }}>
            Body md — neutral typography.
          </p>
          <p
            style={{
              fontFamily: theme.font.mono,
              fontSize: theme.font.sm,
            }}
          >
            Monospace — token reference
          </p>
        </div>
      </section>

      <section className="design-system__section">
        <h2>Shadows</h2>

        <div className="design-system__shadows">
          {shadows.map(([name, value]) => (
            <div
              className="design-system__shadow-card"
              key={name}
              style={{ boxShadow: value }}
            >
              <strong>{name}</strong>
              <code>{value}</code>
            </div>
          ))}
        </div>
      </section>

      <section className="design-system__section">
        <h2>Chamfer</h2>

        <Chamfer className="design-system__chamfer">
          <strong>Chamfer primitive</strong>
          <span>Committed brand motif</span>
        </Chamfer>
      </section>
    </main>
  );
}