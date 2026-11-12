import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { config, isDemo } from "@/lib/server/env";
import { THEME_COLORS, THEME_KEY } from "@/lib/theme";
import { brand } from "@/brand/brand";
import { fontVariables } from "@/brand/fonts";
import "@/brand/tokens.css";
import "./globals.css";

// Demo mode and the operator name come from the server at request time.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: {
      default: config.operatorName,
      template: `%s · ${config.operatorName}`,
    },
    description: brand.tagline,
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLORS.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLORS.dark },
  ],
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
};

// Applies a saved theme before first paint, so dark mode does not flash.
const themeScript = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t)document.documentElement.dataset.theme=t}catch(e){}`;

/**
 * The document, the skip link and the Demo banner, and nothing that reads a session:
 * the staff shell is app/(staff)/layout.tsx, the driver pages' header is
 * app/(driver)/layout.tsx, and the landing page has its own header.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body data-demo={isDemo() ? "" : undefined}>
        <a className="skip" href="#main">
          Skip to content
        </a>
        {isDemo() && (
          <p className="demo-banner" role="status">
            <strong>Demo data</strong>
            <span aria-hidden="true">—</span>
            <Link href="/setup">make it yours</Link>
          </p>
        )}
        {children}
      </body>
    </html>
  );
}
