"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/brand/icons";

export interface NavItem {
  slug: string;
  href: string;
  label: string;
  soon: boolean;
}

/** The sidebar's groups, by module slug. A module not listed goes in the last group. */
const GROUPS: [string, string[]][] = [
  ["Run", ["overview", "live", "chargers", "cards"]],
  ["Money", ["pricing", "reports"]],
  ["Workspace", ["onboarding", "team", "settings"]],
];

/** Main navigation: a grouped sidebar on wide screens, a menu button on phones. */
export default function Nav({
  items,
  account,
}: {
  items: NavItem[];
  /** The account row (who, sign out, theme): at the foot of the sidebar, inside the phone menu. */
  account?: ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close the phone menu after navigating.
  useEffect(() => setOpen(false), [pathname]);

  // Escape closes the phone menu and returns focus to its button.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const listed = GROUPS.flatMap(([, slugs]) => slugs);
  const groups = GROUPS.map(([name, slugs], i) => ({
    name,
    items: items.filter((it) =>
      i === GROUPS.length - 1
        ? slugs.includes(it.slug) || !listed.includes(it.slug)
        : slugs.includes(it.slug),
    ),
  })).filter((g) => g.items.length);

  return (
    <nav aria-label="Main" className="nav">
      <button
        ref={buttonRef}
        type="button"
        className="menu-button"
        aria-expanded={open}
        aria-controls="nav-list"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="menu" />
        Menu
      </button>
      <div id="nav-list" className={open ? "nav-list open" : "nav-list"}>
        <div className="nav-groups">
          {groups.map((g) => (
            <div key={g.name} className="nav-group">
              <p id={`nav-${g.name}`}>{g.name}</p>
              <ul aria-labelledby={`nav-${g.name}`}>
                {g.items.map((item) => {
                  const current =
                    item.href === "/"
                      ? pathname === "/"
                      : pathname === item.href ||
                        pathname.startsWith(`${item.href}/`);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={current ? "page" : undefined}
                      >
                        <Icon name={item.slug} />
                        {item.label}
                        {item.soon && <span className="soon">Soon</span>}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
        {account}
      </div>
    </nav>
  );
}
