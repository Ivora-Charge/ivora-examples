import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { brand, cssVariables } from "@/brand";
import { isDemo } from "@/lib/server/demo";
import "./globals.css";

// Demo mode comes from the server environment at request time.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: `${brand.name} admin`, template: `%s · ${brand.name}` },
  description: "Admin for an EV charging network's own driver app, over OCPI",
};

export const viewport: Viewport = {
  themeColor: brand.color.background,
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const demo = isDemo();
  return (
    <html lang="en">
      <head>
        {/* Brand tokens from brand/tokens.json; globals.css uses only these. */}
        <style>{cssVariables()}</style>
      </head>
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        {demo && (
          <p className="demo-banner" role="status">
            <strong>Demo</strong> Sample data from a built-in mock CPO. No card
            is charged, and nothing is sent to a real CPO, payment provider,
            email or push service.
          </p>
        )}
        <header className="topbar">
          <span className="brand">{brand.name}</span>
          <span className="muted">Admin</span>
          <nav aria-label="Admin" className="nav">
            <Link href="/">Overview</Link>
            <Link href="/admin/peers">CPO peers</Link>
            <Link href="/admin/sessions">Sessions</Link>
            <Link href="/admin/payments">Payments and refunds</Link>
            <Link href="/admin/reconciliation">Reconciliation</Link>
            <Link href="/admin/tokens">Drivers and tokens</Link>
            <Link href="/admin/sign-in">Sign in</Link>
          </nav>
        </header>
        <main id="main" tabIndex={-1}>
          {children}
        </main>
      </body>
    </html>
  );
}
