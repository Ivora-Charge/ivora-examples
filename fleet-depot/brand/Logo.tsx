/** The mark from brand/logo.svg, inline so it takes currentColor and --accent. */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      <rect
        x="3"
        y="3"
        width="42"
        height="42"
        rx="10"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
      />
      <rect x="10" y="12" width="17" height="5" rx="2.5" fill="currentColor" />
      <rect
        x="10"
        y="21.5"
        width="24"
        height="5"
        rx="2.5"
        fill="var(--accent)"
      />
      <rect x="10" y="31" width="12" height="5" rx="2.5" fill="currentColor" />
      <rect x="37" y="9" width="3" height="30" rx="1.5" fill="var(--accent)" />
    </svg>
  );
}
