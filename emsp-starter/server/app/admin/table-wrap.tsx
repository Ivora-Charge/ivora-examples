"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A wide admin table that scrolls sideways inside its card on small screens. When it
 * does not fit, a hint says so, an edge shadow shows there is more, and the region
 * takes keyboard focus (once, before the table) so the arrow keys can scroll it.
 */
export function TableWrap({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setScrolls(el.scrollWidth > el.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      {scrolls && (
        <p className="scroll-hint muted" aria-hidden="true">
          Scroll sideways for more columns
        </p>
      )}
      <div
        ref={ref}
        className="table-wrap"
        role="region"
        aria-label={label}
        tabIndex={scrolls ? 0 : undefined}
      >
        {children}
      </div>
    </>
  );
}
