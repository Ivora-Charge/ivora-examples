import Link from "next/link";
import type { ReactNode } from "react";

export interface SummaryItem {
  label: string;
  value: ReactNode;
  /** Small text after the value, e.g. a unit. */
  unit?: string;
  /** Makes the figure a link. */
  href?: string;
}

/** The figures at the top of a list or detail page, in one row that wraps. */
export function SummaryStrip({
  items,
  label,
}: {
  items: SummaryItem[];
  label: string;
}) {
  return (
    <dl className="strip" aria-label={label}>
      {items.map((it) => {
        const value = (
          <>
            {it.value}
            {it.unit && <small> {it.unit}</small>}
          </>
        );
        return (
          <div key={it.label} className="strip-cell">
            <dt>{it.label}</dt>
            <dd>
              {it.href ? (
                <Link className="strip-link" href={it.href}>
                  {value}
                </Link>
              ) : (
                value
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
