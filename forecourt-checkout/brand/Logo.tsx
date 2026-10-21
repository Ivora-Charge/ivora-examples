/** The mark from brand/logo.svg: an F whose top arm ends in plug prongs. */
export function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="var(--accent)" />
      <path d="M15 12h29v10H26v6h13v9H26v15H15z" fill="var(--on-accent)" />
      <rect
        x="44"
        y="12.5"
        width="10"
        height="4"
        rx="2"
        fill="var(--on-accent)"
      />
      <rect
        x="44"
        y="18.5"
        width="10"
        height="4"
        rx="2"
        fill="var(--on-accent)"
      />
    </svg>
  );
}
