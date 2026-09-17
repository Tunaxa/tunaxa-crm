import type { SVGProps, ReactNode } from "react";

const paths: Record<string, ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  lead: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0M17 8v6M14 11h6" />
    </>
  ),
  contacts: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20a6 6 0 0 1 12 0M17 7h4M17 11h4M17 15h4" />
    </>
  ),
  companies: (
    <>
      <path d="M4 21V5h10v16M14 9h6v12M2 21h20" />
      <path d="M8 9h2M8 13h2M8 17h2M17 13h1M17 17h1" />
    </>
  ),
  pipeline: (
    <>
      <path d="M4 4h16v4H4zM4 10h10v4H4zM4 16h7v4H4z" />
    </>
  ),
  activity: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  tasks: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="m7 12 3 3 7-7" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M3 10h18" />
    </>
  ),
  workflow: (
    <>
      <rect x="3" y="3" width="6" height="6" rx="1" />
      <rect x="15" y="15" width="6" height="6" rx="1" />
      <path d="M9 6h4a4 4 0 0 1 4 4v5M15 18h-4a4 4 0 0 1-4-4V9" />
    </>
  ),
  phone: (
    <path d="M5 4h4l2 5-2.5 1.5a15 15 0 0 0 5 5L15 13l5 2v4c0 1.1-.9 2-2 2C9.7 20.4 3.6 14.3 3 6c0-1.1.9-2 2-2z" />
  ),
  recording: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  inbox: (
    <>
      <path d="M4 5h16v14H4z" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  sequence: (
    <>
      <circle cx="5" cy="6" r="2" />
      <circle cx="19" cy="18" r="2" />
      <path d="M7 6h5a5 5 0 0 1 5 5v5M17 18h-5a5 5 0 0 1-5-5V8" />
    </>
  ),
  ai: (
    <>
      <path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4z" />
      <path d="m18 14 .8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z" />
    </>
  ),
  reports: (
    <>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20V7" />
    </>
  ),
  team: (
    <>
      <circle cx="8" cy="8" r="3" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M2 21a6 6 0 0 1 12 0M14 21a5 5 0 0 1 8 0" />
    </>
  ),
  fields: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 8h8M8 12h5M8 16h7" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.5 1a7 7 0 0 0-1.8-1L14.2 3h-4.4l-.4 3.1a7 7 0 0 0-1.8 1l-2.5-1-2 3.4 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.5-1a7 7 0 0 0 1.8 1l.4 3.1h4.4l.4-3.1a7 7 0 0 0 1.8-1l2.5 1 2-3.4-2-1.5a7 7 0 0 0 .1-1z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  bell: (
    <>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M10 21h4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  arrowLeft: <path d="m15 18-6-6 6-6" />,
  arrowRight: <path d="m9 18 6-6-6-6" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  filter: <path d="M4 5h16l-6 7v5l-4 2v-7z" />,
  download: (
    <>
      <path d="M12 3v12M7 10l5 5 5-5" />
      <path d="M4 20h16" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4M7 9l5-5 5 5" />
      <path d="M4 15v5h16v-5" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  alertCircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5" />
      <path d="M12 16.5h.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l4 2" />
    </>
  ),
  money: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M15 8.5c-.7-.6-1.6-.9-2.7-.9-1.7 0-3 .8-3 2s1.1 1.8 3.1 2.2c2 .4 3.1 1.1 3.1 2.4 0 1.3-1.3 2.2-3.2 2.2-1.2 0-2.4-.4-3.2-1.2M12 5.5v13" />
    </>
  ),
  trend: (
    <>
      <path d="m3 17 6-6 4 4 8-9" />
      <path d="M16 6h5v5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  message: (
    <>
      <path d="M4 5h16v11H8l-4 4z" />
      <path d="M8 9h8M8 13h5" />
    </>
  ),
  play: <path d="m8 5 11 7-11 7z" />,
  pause: <path d="M8 5v14M16 5v14" />,
  mic: (
    <>
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
    </>
  ),
  headset: (
    <>
      <path d="M4 13v-2a8 8 0 0 1 16 0v2" />
      <path d="M4 13h3v6H5a1 1 0 0 1-1-1zM20 13h-3v6h2a1 1 0 0 0 1-1zM17 19c0 2-2 2-4 2" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 4 7v5c0 5 3.5 8 8 9 4.5-1 8-4 8-9V7z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
    </>
  ),
  tag: (
    <>
      <path d="M20 13 13 20 4 11V4h7z" />
      <circle cx="8" cy="8" r="1" />
    </>
  ),
  building: (
    <>
      <path d="M4 21V6l8-3 8 3v15M2 21h20" />
      <path d="M8 9h1M12 9h1M16 9h1M8 13h1M12 13h1M16 13h1M10 21v-4h4v4" />
    </>
  ),
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2 2 0 0 1 3 3L8 18l-4 1 1-4z" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18M8 6V3h8v3M6 6l1 15h10l1-15" />
      <path d="M10 10v7M14 10v7" />
    </>
  ),
  logout: (
    <>
      <path d="M10 17l5-5-5-5M15 12H3" />
      <path d="M14 3h7v18h-7" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 15.5A8 8 0 0 1 8.5 4 8 8 0 1 0 20 15.5z" />,
  keypad: (
    <>
      <circle cx="7" cy="6" r="1" />
      <circle cx="12" cy="6" r="1" />
      <circle cx="17" cy="6" r="1" />
      <circle cx="7" cy="11" r="1" />
      <circle cx="12" cy="11" r="1" />
      <circle cx="17" cy="11" r="1" />
      <circle cx="7" cy="16" r="1" />
      <circle cx="12" cy="16" r="1" />
      <circle cx="17" cy="16" r="1" />
    </>
  ),
  spark: (
    <>
      <path d="m12 2 1.3 4.7L18 8l-4.7 1.3L12 14l-1.3-4.7L6 8l4.7-1.3z" />
      <path d="m19 15 .6 2.4L22 18l-2.4.6L19 21l-.6-2.4L16 18l2.4-.6z" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3 2 21h20z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    </>
  ),
  send: (
    <>
      <path d="m22 2-7 20-4-9-9-4z" />
      <path d="M22 2 11 13" />
    </>
  ),
  campaign: (
    <>
      <path d="M3 11v3a1 1 0 0 0 1 1h2l3 4a1 1 0 0 0 1-1v-3l4 1a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1l-4 1V6a1 1 0 0 0-1-1l-3 4H4a1 1 0 0 0-1 1z" />
      <path d="M19 9a4 4 0 0 1 0 6" />
    </>
  ),
  cart: (
    <>
      <circle cx="9" cy="20" r="1.5" />
      <circle cx="18" cy="20" r="1.5" />
      <path d="M2 3h3l2.5 12.5a2 2 0 0 0 2 1.5h7.6a2 2 0 0 0 2-1.6L21 7H6" />
    </>
  ),
  invoice: (
    <>
      <path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" />
      <path d="M14 2v5h5M9 12h6M9 16h6" />
    </>
  ),
  employee: (
    <>
      <rect x="8" y="2" width="8" height="6" rx="1" />
      <path d="M4 22a8 8 0 0 1 16 0" />
      <path d="M12 10v3" />
    </>
  ),
  landing: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M3 9h18M8 21h8M12 17v4" />
      <path d="m9 15 3-3 3 3" />
    </>
  ),
  leave: (
    <>
      <circle cx="9" cy="7" r="3.5" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <path d="m16 15 5 5M21 15l-5 5" />
    </>
  ),
  clockIn: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5M16 14" />
    </>
  ),
  quote: (
    <>
      <path d="M5 4h14a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9l-4 4V5a1 1 0 0 1 1-1z" />
      <path d="M8 9h8M8 13h5M8 17h2" />
    </>
  ),
  contract: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h4" />
    </>
  ),
  event: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M3 10h18" />
      <circle cx="12" cy="15" r="2.5" />
      <path d="m12 17.5 1 1.5 3-1" />
    </>
  ),
  goal: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" />
      <path d="M12 3v2M21 12h-2M12 21v-2M3 12h2" />
    </>
  ),
  survey: (
    <>
      <path d="M9 11 11 13l4-4" />
      <path d="M4 5h16v16H4z" />
      <path d="M4 21a8 8 0 0 1 16 0" opacity="0" />
      <path d="M8 2h8v3H8z" />
    </>
  ),
  response: (
    <>
      <path d="M4 5h16v11H8l-4 4z" />
      <path d="m8 10 2 2 3-4" />
    </>
  ),
  duplicate: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
      <path d="M12 11v6M9 14h6" />
    </>
  ),
  portal: (
    <>
      <path d="M12 3 4 6v5c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />
      <rect x="9.5" y="11" width="5" height="7" rx="1" />
      <path d="M10 9h4" />
    </>
  ),
  form: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5M14 16h2M16 20h2" />
    </>
  ),
  webhook: (
    <>
      <path d="M8.5 19a2.5 2.5 0 1 1 0-5L14 4.5a4 4 0 1 1 6 5.3l-7 8.2" />
      <path d="M10.5 16 5.5 20m2.9-10-4.2-1.5a4 4 0 1 1 2.6-6.4l8.1 6.5" />
    </>
  ),
};

export function Icon({
  name,
  size = 18,
  ...props
}: SVGProps<SVGSVGElement> & { name: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {paths[name] ?? paths.dashboard}
    </svg>
  );
}
