import { Suspense, type ReactNode } from "react";

type Shape = "stats" | "list" | "detail" | "driver";

/**
 * Shown while a page loads: blocks shaped like the page that is coming (a title, then
 * stat cards or rows). Pulses unless the visitor asks for less motion.
 */
export function LoadingSkeleton({ shape = "list" }: { shape?: Shape }) {
  const rows = shape === "driver" ? 2 : shape === "detail" ? 3 : 5;
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="visually-hidden">Loading…</span>
      <div aria-hidden="true">
        <div className="skeleton skeleton-title" />
        {shape === "stats" && (
          <div className="stats">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="skeleton skeleton-stat" />
            ))}
          </div>
        )}
        <div className="card">
          <div className="skeleton skeleton-line short" />
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="skeleton skeleton-line" />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * A page's own loading boundary. Pages check what can answer 404 (a module that is
 * off, a malformed id) before it, because once the skeleton streams the status is
 * fixed at 200. Per page, not a loading.tsx, so it never wraps a child route's 404.
 */
export function Loading({
  shape,
  children,
}: {
  shape?: Shape;
  children: ReactNode;
}) {
  return (
    <Suspense fallback={<LoadingSkeleton shape={shape} />}>{children}</Suspense>
  );
}
