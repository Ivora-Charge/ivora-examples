"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export interface NavItem {
  href: string;
  label: string;
  soon: boolean;
}

/** Main navigation: a sidebar on wide screens, a menu button on phones. */
export default function Nav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close the phone menu after navigating.
  useEffect(() => setOpen(false), [pathname]);

  return (
    <nav aria-label="Main" className="nav">
      <button
        type="button"
        className="menu-button"
        aria-expanded={open}
        aria-controls="nav-list"
        onClick={() => setOpen((o) => !o)}
      >
        Menu
      </button>
      <ul id="nav-list" className={open ? "nav-list open" : "nav-list"}>
        {items.map((item) => {
          const current =
            item.href === "/"
              ? pathname === "/"
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={current ? "page" : undefined}
              >
                {item.label}
                {item.soon && <span className="soon">Soon</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
