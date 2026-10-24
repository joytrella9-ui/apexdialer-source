import { useId } from "react";

export function Mark({ size = 28 }: { size?: number }) {
  const raw = useId().replace(/:/g, "");
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id={raw} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#9af6ff" />
          <stop offset="1" stopColor="#2ec8e6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="#071018" />
      <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="8.25" fill="none" stroke={`url(#${raw})`} />
      <path d="M6.2 23.2a10 10 0 1 1 19.6 0" fill="none" stroke={`url(#${raw})`} strokeWidth="2" strokeLinecap="round" />
      <path d="M11 23.4 16 9.2l5 14.2" fill="none" stroke="#f4fbff" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      <path d="M13 18.5h6" stroke="#5ce1ff" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark({ height = 22, className = "", tone = "light" }: { height?: number; className?: string; tone?: "light" | "dark" }) {
  const width = Math.round(height * (132 / 28));
  const ink = tone === "light" ? "#f4fbff" : "#122033";
  const bar = tone === "light" ? "#5ce1ff" : "#1d4ed8";
  return (
    <svg className={`wordmark ${className}`} height={height} width={width} viewBox="0 0 132 28" role="img" aria-label="Apex">
      <path d="M2 26 13 3.2 24 26" fill="none" stroke={ink} strokeWidth="2.3" strokeLinejoin="round" strokeLinecap="round" />
      <path d="M6.6 17.6h12.8" stroke={bar} strokeWidth="2.1" strokeLinecap="round" />
      <path d="M36 26V3.2h11.2a6.4 6.4 0 0 1 0 12.8H36" fill="none" stroke={ink} strokeWidth="2.3" strokeLinejoin="round" strokeLinecap="round" />
      <path d="M66 3.2h16.4M66 14.6h13.2M66 26h16.4M66 3.2V26" fill="none" stroke={ink} strokeWidth="2.3" strokeLinecap="round" />
      <path d="M94.5 3.2 112 26M112 3.2 94.5 26" fill="none" stroke={ink} strokeWidth="2.3" strokeLinecap="round" />
    </svg>
  );
}
