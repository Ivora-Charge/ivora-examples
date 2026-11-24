import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { brand, cssVariables } from "@/brand";
import { fontFamilies } from "@/brand/fonts";
import { requestAdmin } from "./admin/ui/current-admin";
import { adminEnabled } from "@/lib/server/admin";
import { isDemo } from "@/lib/server/demo";
import { AdminProvider } from "./admin/ui/admin-context";
import { Shell } from "./admin/ui/shell";
import "./globals.css";

// Demo mode and who is signed in come from the server at request time.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: `${brand.name} admin`, template: `%s · ${brand.name}` },
  description: "Admin for an EV charging network's own driver app, over OCPI",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: brand.color.background },
    {
      media: "(prefers-color-scheme: dark)",
      color: brand.colorDark.background,
    },
  ],
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  const demo = isDemo();
  // Only who is signed in reaches the page: the email and role, never the token.
  const admin = await requestAdmin();
  return (
    <html lang="en">
      <head>
        {/* Brand tokens from brand/tokens.json, with the self-hosted brand fonts
            from brand/fonts.ts; globals.css uses only these. */}
        <style>{cssVariables(brand, fontFamilies)}</style>
      </head>
      <body>
        <nav aria-label="Skip">
          <a className="skip" href="#main">
            Skip to content
          </a>
        </nav>
        {demo && (
          <p className="demo-banner" role="status">
            <strong>Demo</strong> Sample data from a built-in mock CPO. No card
            is charged, and nothing is sent to a real CPO, payment provider,
            email or push service.
          </p>
        )}
        <AdminProvider
          admin={admin && { email: admin.email, role: admin.role }}
          secretEnabled={adminEnabled()}
          demo={demo}
        >
          <Shell name={brand.name}>{children}</Shell>
        </AdminProvider>
      </body>
    </html>
  );
}
