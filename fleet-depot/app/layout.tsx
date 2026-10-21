import type { ReactNode } from "react";
import { brand } from "@/brand/brand";
import { fontVariables } from "@/brand/fonts";
import { Logo } from "@/brand/Logo";
import "@/brand/tokens.css";
import "./globals.css";
import { THEME_KEY } from "@/lib/theme";
import ThemeToggle from "./theme-toggle";

export const metadata = {
  title: brand.name,
  description: brand.tagline,
};

// Applies a saved theme before first paint, so dark mode does not flash.
const themeScript = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t)document.documentElement.dataset.theme=t}catch(e){}`;

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
        <header className="brandbar">
          <a className="home" href="/" aria-label={`${brand.name}, overview`}>
            <Logo />
            <span>{brand.name}</span>
          </a>
          <ThemeToggle />
        </header>
        {children}
        <footer className="foot">
          {brand.tagline}. {brand.support}
        </footer>
      </body>
    </html>
  );
}
