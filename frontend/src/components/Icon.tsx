/**
 * CodeConClave — professional stroke icon system (single source).
 * All icons are 24x24 stroke glyphs, rendered in currentColor so they adopt
 * the active/hover/disabled states of their host control. No emoji, no
 * cartoon icons. Reduced-motion friendly (static glyphs).
 */
import type { ReactNode } from 'react';

export type IconName =
  | 'home'
  | 'chat'
  | 'folder'
  | 'layers'
  | 'brain'
  | 'dna'
  | 'file'
  | 'terminal'
  | 'bolt'
  | 'cog'
  | 'monitor'
  | 'users'
  | 'puzzle'
  | 'sliders'
  | 'radio'
  | 'bulb'
  | 'database'
  | 'refresh'
  | 'trash'
  | 'clock'
  | 'settings'
  | 'check'
  | 'chart'
  | 'user'
  | 'sparkle'
  | 'search'
  | 'bell'
  | 'logout'
  | 'menu'
  | 'plus'
  | 'send'
  | 'mic'
  | 'paperclip'
  | 'command'
  | 'stop'
  | 'image'
  | 'thumbUp'
  | 'thumbDown'
  | 'copy'
  | 'edit'
  | 'share'
  | 'pin'
  | 'close'
  | 'external'
  | 'shield'
  | 'key'
  | 'wallet'
  | 'download'
  | 'arrowRight'
  | 'spark'
  | 'sun'
  | 'moon'
  | 'chevronUp'
  | 'chevronDown';

const PATHS: Record<IconName, ReactNode> = {
  home: (
    <>
      <path d="M3 10.5 12 3.5l9 7" />
      <path d="M5 9.5V20h14V9.5" />
      <path d="M9.5 20v-6h5v6" />
    </>
  ),
  chat: <path d="M4 5h16v11H9l-4 3.5V16H4z" />,
  folder: (
    <>
      <path d="M3 6.5h6l2 2h10v10H3z" />
      <path d="M3 9.5h18" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3.5 21 8l-9 4.5L3 8z" />
      <path d="M3 12.5l9 4.5 9-4.5" />
      <path d="M3 16.5l9 4.5 9-4.5" />
    </>
  ),
  brain: (
    <>
      <path d="M9.5 4a2.5 2.5 0 0 0-5 .6A3 3 0 0 0 4 11.6 3 3 0 0 0 6.5 20a2.5 2.5 0 0 0 3 .4A2.5 2.5 0 0 0 12 17.5V4.5z" />
      <path d="M14.5 4a2.5 2.5 0 0 1 5 .6A3 3 0 0 1 20 11.6 3 3 0 0 1 17.5 20a2.5 2.5 0 0 1-3 .4A2.5 2.5 0 0 1 12 17.5" />
      <path d="M9 12.5c1 .7 2 .7 3 0s2-.7 3 0" />
    </>
  ),
  dna: (
    <>
      <path d="M8 3c4 3.5-4 6.5 0 10s-4 6.5 0 10" />
      <path d="M16 3c-4 3.5 4 6.5 0 10s4 6.5 0 10" />
      <path d="M8 8h8M8 16h8" />
    </>
  ),
  file: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
      <path d="M9 13h6M9 17h6" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="m7.5 10 3 2.5-3 2.5" />
      <path d="M13 15h3.5" />
    </>
  ),
  bolt: <path d="M13 2.5 4.5 13.5H10l-1.5 8L18 10.5h-5.5z" />,
  cog: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="12.5" rx="2" />
      <path d="M9 20h6M12 16.5V20" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 19c.6-3 2.9-4.5 5.5-4.5s4.9 1.5 5.5 4.5" />
      <path d="M16 6a3 3 0 0 1 0 5.5M18.5 14.8c1.4.7 2 2 2.2 3.7" />
    </>
  ),
  puzzle: (
    <>
      <path d="M9 3.5h2.5v2.5a1.75 1.75 0 0 0 3.5 0V3.5h2.5c1 0 1.5.5 1.5 1.5v3h-2.5a1.75 1.75 0 0 0 0 3.5H19V16h-2.5v2.5c0 1-.5 1.5-1.5 1.5H4.5c-1 0-1.5-.5-1.5-1.5V5c0-1 .5-1.5 1.5-1.5H9z" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h16M4 12h16M4 17h16" />
      <circle cx="9" cy="7" r="2.2" />
      <circle cx="15" cy="12" r="2.2" />
      <circle cx="7" cy="17" r="2.2" />
    </>
  ),
  radio: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M5.5 5.5a9 9 0 0 0 0 13M18.5 5.5a9 9 0 0 1 0 13" />
    </>
  ),
  bulb: (
    <>
      <path d="M9 18h6M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.5 10.9c.8.6 1.3 1.3 1.5 2.1h4c.2-.8.7-1.5 1.5-2.1A6 6 0 0 0 12 3z" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" />
      <path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13" />
      <path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.7" />
      <path d="M20 3.5v4h-4" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9 7V4.5h6V7M6 7l1 13h10l1-13" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.3 5.3l1.7 1.7M17 17l1.7 1.7M18.7 5.3 17 7M7 17l-1.7 1.7" />
    </>
  ),
  check: <path d="m4.5 12.5 5 5 10-11" />,
  chart: (
    <>
      <path d="M4 4v16h16" />
      <path d="M8 16v-5M12 16V8M16 16v-8" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20c.8-4 3.8-6 7.5-6s6.7 2 7.5 6" />
    </>
  ),
  sparkle: <path d="M12 2.5c.8 4.5 3 6.7 7.5 7.5-4.5.8-6.7 3-7.5 7.5-.8-4.5-3-6.7-7.5-7.5 4.5-.8 6.7-3 7.5-7.5z" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
    </>
  ),
  bell: (
    <>
      <path d="M6 9.5a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7" />
      <path d="M10 20a2.2 2.2 0 0 0 4 0" />
    </>
  ),
  logout: (
    <>
      <path d="M14 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H14" />
      <path d="M14 7.5V12l0 4.5M10 12h10" />
    </>
  ),
  menu: <path d="M4 6.5h16M4 12h16M4 17.5h16" />,
  plus: <path d="M12 5v14M5 12h14" />,
  send: (
    <>
      <path d="M4 20 21 12 4 4l2.5 8z" />
      <path d="M6.5 12H21" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11.5" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
    </>
  ),
  paperclip: (
    <>
      <path d="m9.5 13 5.5-5.5a2.5 2.5 0 0 1 3.5 3.5l-7.5 7.5a4.5 4.5 0 0 1-6.5-6.5l8-8a6.5 6.5 0 0 1 9 9l-5.8 5.8" />
    </>
  ),
  command: (
    <>
      <path d="M9 9V5.5a2.5 2.5 0 0 0-5 0C4 8.5 7 9 9 9zm0 0h6M15 9v-3.5a2.5 2.5 0 0 1 5 0C20 8.5 17 9 15 9zM15 15v3.5a2.5 2.5 0 0 0 5 0c0-3-3-3.5-5-3.5zm-6 0v3.5a2.5 2.5 0 0 1-5 0c0-3 3-3.5 5-3.5z" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="m6 16 4-4 3 3 2.5-2.5 2.5 3.5" />
    </>
  ),
  thumbUp: (
    <>
      <path d="M8 10.5V19M8 10.5 11 4c1-.2 2 .4 2 1.4V9h4.5c1 0 1.6.9 1.3 1.8l-1.6 5.4c-.2.6-.8 1-1.4 1H8" />
      <path d="M4.5 11h3.5v8H4.5z" />
    </>
  ),
  thumbDown: (
    <>
      <path d="M16 13.5V5M16 13.5 13 20c-1 .2-2-.4-2-1.4V15H6.5c-1 0-1.6-.9-1.3-1.8l1.6-5.4c.2-.6.8-1 1.4-1H16" />
      <path d="M19.5 13h-3.5V5h3.5z" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </>
  ),
  edit: (
    <>
      <path d="M4 16.5V20h3.5L18.5 9a2.5 2.5 0 0 0-3.5-3.5L4 16.5z" />
      <path d="m13.5 7 3.5 3.5" />
    </>
  ),
  share: <path d="M12 3.5v11M7.5 7 12 3.5 16.5 7M5 13v6h14v-6" />,
  pin: (
    <>
      <path d="M9 5h6l-1 5 2.5 2.5V14H7.5v-1.5L10 10z" />
      <path d="M12 16.5V19" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M16 13v6H5V8h6" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 4.5 6v6c0 4.5 3 7.8 7.5 9.5 4.5-1.7 7.5-5 7.5-9.5V6z" />
      <path d="m8.5 12 2.5 2.5 4.5-4.5" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4.5" />
      <path d="m11.5 11.5 8.5-8.5M17.5 5.5 20 8M14.5 8.5 17 11" />
    </>
  ),
  wallet: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10.5h18" />
      <circle cx="16.5" cy="14.5" r="1.2" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v10M8 10l4 4 4-4" />
      <path d="M4.5 19.5h15" />
    </>
  ),
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v3M12 19v3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M2 12h3M19 12h3M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12" />
    </>
  ),
  moon: <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />,
  spark: (
    <>
      <path d="M12 2.5c.7 4.2 2.8 6.3 7 7-4.2.7-6.3 2.8-7 7-.7-4.2-2.8-6.3-7-7 4.2-.7 6.3-2.8 7-7z" />
      <path d="M19 15c.3 1.9 1.3 2.9 3.2 3.2-1.9.3-2.9 1.3-3.2 3.2-.3-1.9-1.3-2.9-3.2-3.2 1.9-.3 2.9-1.3 3.2-3.2z" />
    </>
  ),
  chevronUp: <path d="M18 15l-6-6-6 6" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
};

export function Icon({
  name,
  size = 18,
  className,
  strokeWidth = 1.6,
}: {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      className={className ?? 'cc-sidebar__icon'}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}