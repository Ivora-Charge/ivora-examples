import type { ReactNode } from "react";
import { Logo } from "@/brand/Logo";
import { config } from "@/lib/server/env";
import ThemeToggle from "../theme-toggle";

/**
 * Driver pages (the sticker page and the demo checkout): phone-first, one column, the
 * operator's name on top and no staff navigation. Reads no session.
 */
export default function DriverLayout({ children }: { children: ReactNode }) {
  return (
    <div className="driver-shell">
      <header className="driver-bar">
        <p className="driver-operator">
          <Logo size={28} />
          <span>{config.operatorName}</span>
        </p>
        <ThemeToggle />
      </header>
      <main id="main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
