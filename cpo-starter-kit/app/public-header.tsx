import type { ReactNode } from "react";
import { brand } from "@/brand/brand";
import { Logo } from "@/brand/Logo";
import ThemeToggle from "./theme-toggle";

/**
 * The bar on pages outside the staff app: the mark, and on the landing page the theme
 * switch and one action. Error and 404 pages leave the switch out, so their always-loaded
 * boundaries ship no client code beyond the error state.
 */
export function PublicHeader({
  toggle = false,
  children,
}: {
  toggle?: boolean;
  children?: ReactNode;
}) {
  return (
    <header className="public-bar">
      <a className="brand" href="/welcome" aria-label={`${brand.name}, home`}>
        <Logo />
        <span>{brand.name}</span>
      </a>
      {toggle && <ThemeToggle />}
      {children}
    </header>
  );
}
