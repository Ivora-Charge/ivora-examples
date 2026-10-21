"use client";
import { useEffect, useState } from "react";
import { THEME_KEY } from "@/lib/theme";

/** Light/dark switch. Until it is used, the page follows the system setting. */
export default function ThemeToggle() {
  const [dark, setDark] = useState<boolean>();
  useEffect(() => {
    const set = document.documentElement.dataset.theme;
    setDark(
      set ? set === "dark" : matchMedia("(prefers-color-scheme: dark)").matches,
    );
  }, []);
  return (
    <button
      type="button"
      className="secondary theme"
      aria-pressed={dark}
      onClick={() => {
        const theme = dark ? "light" : "dark";
        document.documentElement.dataset.theme = theme;
        localStorage.setItem(THEME_KEY, theme);
        setDark(!dark);
      }}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <circle
          cx="12"
          cy="12"
          r="9"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
        />
        <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />
      </svg>
      Dark mode
    </button>
  );
}
