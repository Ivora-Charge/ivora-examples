/** The mark from brand/logo.svg, inline so it follows the theme's --color-primary and --color-accent. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      <path
        d="M18 2H46V30A16 16 0 0 1 30 46H2V18A16 16 0 0 1 18 2Z"
        fill="var(--color-primary)"
      />
      <g
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="4"
        strokeLinecap="round"
      >
        <path d="M11 37 33 15" />
        <path d="M18 30V22M25 23V14" />
      </g>
      <circle cx="35.5" cy="12.5" r="3.5" fill="var(--color-accent)" />
    </svg>
  );
}
