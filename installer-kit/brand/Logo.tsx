/** The mark from brand/logo.svg, inline so it takes currentColor and --accent. */
export function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      <path d="M5 4h9v29h12v9H5z" fill="currentColor" />
      <path d="M25 35h7v5h-7z" fill="var(--accent, currentColor)" />
      <circle
        cx="37.5"
        cy="37.5"
        r="6.5"
        fill="none"
        stroke="var(--accent, currentColor)"
        strokeWidth="4"
      />
    </svg>
  );
}
