import type { ReactNode } from "react";
import Link from "next/link";
import { brand } from "../../brand/brand";
import { fontVariables } from "../../brand/fonts";
import { Logo } from "../../brand/Logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { settings } from "@/lib/server/services";
import { THEME_KEY } from "@/lib/theme";
import "../../brand/tokens.css";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: brand.name,
  description:
    "Pay at the charger: card hold, live charging, idle fees and receipts.",
};

export const viewport = { width: "device-width", initialScale: 1 };

// Applies a saved theme before first paint, so dark mode does not flash.
const themeScript = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t)document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  const demo = settings().demo;
  return (
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <a className="skip" href="#content">
          Skip to content
        </a>
        {demo && (
          <div className="demo-banner" role="status">
            Demo mode: sample data only. No card is charged and no charger
            receives a command.
          </div>
        )}
        <header className="brandbar no-print">
          <Link className="home" href="/" aria-label={`${brand.name}, home`}>
            <Logo />
            <span>{brand.name}</span>
          </Link>
          <ThemeToggle />
        </header>
        <div id="content" tabIndex={-1}>
          {children}
        </div>
        <footer className="foot no-print">
          {brand.tagline}. {brand.support}
        </footer>
      </body>
    </html>
  );
}
