/** Shown while a page loads: grey blocks shaped like a title, stats and a card. */
export function LoadingSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="visually-hidden">Loading…</span>
      <div className="skeleton skeleton-title" aria-hidden="true" />
      <div className="stats" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton skeleton-stat" />
        ))}
      </div>
      <div className="skeleton skeleton-card" aria-hidden="true" />
    </div>
  );
}
