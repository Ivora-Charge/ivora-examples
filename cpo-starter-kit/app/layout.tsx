import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { config, isDemo } from "@/lib/server/env";
import { MODULES } from "@/lib/modules";
import Nav from "./nav";
import "./globals.css";

// Demo mode and the operator name come from the server environment at request time.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: {
      default: config.operatorName,
      template: `%s · ${config.operatorName}`,
    },
    description: "EV charging operations on the Ivora API",
  };
}

export const viewport: Viewport = {
  themeColor: "#0d1117",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const demo = isDemo();
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        {demo && (
          <p className="demo-banner" role="status">
            <strong>Demo</strong> Sample data only. Nothing is sent to Ivora,
            chargers, payment providers or email.
          </p>
        )}
        <div className="shell">
          <header className="topbar">
            <span className="brand">{config.operatorName}</span>
            <Nav
              items={MODULES.map(({ href, label, status }) => ({
                href,
                label,
                soon: status === "coming-soon",
              }))}
            />
          </header>
          <main id="main" tabIndex={-1}>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
