import type { Metadata, Viewport } from "next";
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
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        {isDemo() && (
          <p className="demo-banner" role="status">
            <strong>Demo mode:</strong> add your Ivora API key in settings to go
            live.
            <span className="detail">
              Settings means your deployment&apos;s environment variables (for
              example Vercel Project Settings → Environment Variables). Sample
              data only: nothing is sent to Ivora, chargers, payment providers
              or email.
            </span>
          </p>
        )}
        {children}
      </body>
    </html>
  );
}
