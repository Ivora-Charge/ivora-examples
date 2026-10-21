import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { config, isDemo } from "@/lib/server/env";
import { currentStaff } from "@/lib/server/auth";
import { MODULES } from "@/lib/modules";
import { ROLE_LABELS } from "@/lib/roles";
import { THEME_COLORS, THEME_KEY } from "@/lib/theme";
import { brand } from "@/brand/brand";
import { fontVariables } from "@/brand/fonts";
import { Logo } from "@/brand/Logo";
import "@/brand/tokens.css";
import { signOutAction } from "./auth-actions";
import Nav from "./nav";
import ThemeToggle from "./theme-toggle";
import "./globals.css";

// Demo mode, the operator name and the session come from the server at request time.
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

async function signedInStaff() {
  try {
    return await currentStaff();
  } catch (e) {
    // A setup problem (keys, migrations) must not take down the sign-in page.
    console.error("cpo-starter-kit: session check failed:", {
      error: e instanceof Error ? e.name : "error",
    });
    return null;
  }
}

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  const demo = isDemo();
  const staff = await signedInStaff();
  return (
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        {demo && (
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
        <div className={staff ? "shell" : "shell signed-out"}>
          <header className="topbar">
            <a className="brand" href="/" aria-label={`${brand.name}, home`}>
              <Logo />
              <span>{brand.name}</span>
            </a>
            {!staff && <ThemeToggle />}
            {staff && (
              <>
                <p className="workspace">
                  <span>Workspace</span>
                  {config.operatorName}
                </p>
                <Nav
                  items={MODULES.map(({ slug, href, label, status }) => ({
                    slug,
                    href,
                    label,
                    soon: status === "coming-soon",
                  }))}
                />
                <div className="who">
                  <span>
                    {staff.email} · {ROLE_LABELS[staff.role]}
                  </span>
                  {staff.demo ? (
                    <span className="badge">Sample</span>
                  ) : (
                    <form action={signOutAction}>
                      <button type="submit" className="button secondary">
                        Sign out
                      </button>
                    </form>
                  )}
                  <ThemeToggle />
                </div>
              </>
            )}
          </header>
          <main id="main" tabIndex={-1}>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
