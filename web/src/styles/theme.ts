export const theme = {
  color: {
    bg: "var(--color-bg)",
    surface: "var(--color-surface)",
    surface2: "var(--color-surface-2)",
    text: "var(--color-text)",
    textMuted: "var(--color-text-muted)",
    textFaint: "var(--color-text-faint)",
    border: "var(--color-border)",
    borderStrong: "var(--color-border-strong)",
    success: "var(--color-success)",
    danger: "var(--color-danger)",
    warning: "var(--color-warning)",
  },

  space: {
    1: "var(--space-1)",
    2: "var(--space-2)",
    3: "var(--space-3)",
    4: "var(--space-4)",
    5: "var(--space-5)",
    6: "var(--space-6)",
    8: "var(--space-8)",
    10: "var(--space-10)",
    12: "var(--space-12)",
    16: "var(--space-16)",
  },

  radius: {
    none: "var(--radius-none)",
    sm: "var(--radius-sm)",
    md: "var(--radius-md)",
    lg: "var(--radius-lg)",
    xl: "var(--radius-xl)",
    full: "var(--radius-full)",
  },

  font: {
    sans: "var(--font-family-sans)",
    mono: "var(--font-family-mono)",
    xs: "var(--font-size-xs)",
    sm: "var(--font-size-sm)",
    md: "var(--font-size-md)",
    lg: "var(--font-size-lg)",
    xl: "var(--font-size-xl)",
    "2xl": "var(--font-size-2xl)",
    "3xl": "var(--font-size-3xl)",
  },

  shadow: {
    sm: "var(--shadow-sm)",
    md: "var(--shadow-md)",
    lg: "var(--shadow-lg)",
  },
} as const;

export type Theme = typeof theme;