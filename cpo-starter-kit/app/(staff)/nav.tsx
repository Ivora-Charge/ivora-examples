"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
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
export default function Nav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close the phone menu after navigating.
  useEffect(() => setOpen(false), [pathname]);

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
    </nav>
  );
}
