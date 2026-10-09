export const PlaneIcon = ({ size = 20, color = "#fff" }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden="true">
    <path d="M21 15.5v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V8.5l-8 5v2l8-2.5V18l-2 1.5V21l3.5-1 3.5 1v-1.5L13 18v-5z" />
  </svg>
);

export const SearchIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-4-4" />
  </svg>
);

export const FireIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z" />
  </svg>
);

export const BellIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10 21h4" />
  </svg>
);

export const Check = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2 6.5 5 9l5-6" stroke="#fff" strokeWidth="2" fill="none" />
  </svg>
);

export const Chevron = ({ dir }: { dir: "left" | "right" }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d={dir === "left" ? "M10 3 5 8l5 5" : "m6 3 5 5-5 5"} stroke="currentColor" strokeWidth="2" fill="none" />
  </svg>
);

export const Cross = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path d="m3 3 8 8M11 3l-8 8" stroke="currentColor" strokeWidth="2" />
  </svg>
);
