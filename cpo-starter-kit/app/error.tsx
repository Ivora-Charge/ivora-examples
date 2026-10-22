"use client";

import { brand } from "@/brand/brand";
import { Logo } from "@/brand/Logo";
import { ErrorState } from "./states";

/**
 * A failure outside the staff app (or in its shell itself). Loaded with every page, so
 * it keeps to the mark and the error state.
 */
export default function ErrorPage(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <>
      <header className="public-bar">
        <a className="brand" href="/welcome" aria-label={`${brand.name}, home`}>
          <Logo />
          <span>{brand.name}</span>
        </a>
      </header>
      <main id="main" tabIndex={-1} className="public-main">
        <ErrorState {...props} />
      </main>
    </>
  );
}
