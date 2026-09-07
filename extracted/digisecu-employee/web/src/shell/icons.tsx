import type { ReactNode } from "react";

export type IconName =
  | "home" | "org" | "users" | "plus" | "check" | "clock"
  | "mail" | "list" | "search" | "shield" | "sliders"
  | "door" | "folder" | "globe" | "git" | "book" | "arrowRight" | "chevron"
  // SOAR 콘솔 추가분
  | "grid" | "ticket" | "pulse" | "doc" | "alert" | "lock";

const PATHS: Record<IconName, ReactNode> = {
  home: <><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M9 22V12h6v10" /></>,
  org: <><path d="M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" /><path d="M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" /><path d="M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" /><path d="M8.6 13.5l6.8 3.9M15.4 6.6l-6.8 3.9" /></>,
  users: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M20 6L9 17l-5-5" />,
  clock: <><path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z" /><path d="M12 6v6l4 2" /></>,
  mail: <><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" /><path d="M22 6l-10 7L2 6" /></>,
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  search: <><path d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z" /><path d="M21 21l-4.3-4.3" /></>,
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  sliders: <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />,
  door: <><path d="M4 21h16" /><path d="M7 21V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v17" /><path d="M14 12h.02" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  globe: <><path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z" /><path d="M2 12h20" /><path d="M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z" /></>,
  git: <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />,
  book: <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z" />,
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  grid: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>,
  ticket: <path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5v2a2.5 2.5 0 0 0 0 5v2a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5v-2a2.5 2.5 0 0 0 0-5v-2z" />,
  pulse: <path d="M3 12h4l2.5-6 4 12L16 12h5" />,
  doc: <><path d="M6 3.5h7.5L18.5 8v12.5h-12.5V3.5z" /><path d="M13 3.5V8.5h5M9 13h6M9 16.5h4" /></>,
  alert: <><path d="M12 3.5 2.8 19.5h18.4L12 3.5z" /><path d="M12 10v4" /><circle cx="12" cy="16.8" r="0.6" fill="currentColor" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="9.5" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>,
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
