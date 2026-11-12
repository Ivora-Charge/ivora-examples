"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { nextTabIndex } from "@/lib/data-table";

export interface TabSpec {
  id: string;
  label: string;
  panel: ReactNode;
}

/**
 * Tabs for a detail page. Arrow keys, Home and End move between tabs (only the
 * selected one is in the tab order); the panel is the next stop after the tab list.
 */
export function Tabs({
  tabs,
  label,
  initial,
}: {
  tabs: TabSpec[];
  label: string;
  initial?: string;
}) {
  const base = useId();
  const [selected, setSelected] = useState(
    Math.max(
      0,
      tabs.findIndex((t) => t.id === initial),
    ),
  );
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div className="tabs">
      <div role="tablist" aria-label={label}>
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="tab"
            type="button"
            id={`${base}-tab-${t.id}`}
            aria-selected={i === selected}
            aria-controls={`${base}-panel-${t.id}`}
            tabIndex={i === selected ? 0 : -1}
            onClick={() => setSelected(i)}
            onKeyDown={(e) => {
              const to = nextTabIndex(e.key, i, tabs.length);
              if (to === null) return;
              e.preventDefault();
              setSelected(to);
              refs.current[to]?.focus();
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t, i) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${base}-panel-${t.id}`}
          aria-labelledby={`${base}-tab-${t.id}`}
          hidden={i !== selected}
          tabIndex={0}
        >
          {t.panel}
        </div>
      ))}
    </div>
  );
}
