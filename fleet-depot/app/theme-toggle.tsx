"use client";
import { useEffect, useState } from "react";
import { THEME_KEY } from "@/lib/theme";

/** Light/dark switch, labelled by the action it performs. Until it is used, the page follows the system setting. */
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
      className="theme"
      onClick={() => {
        const theme = dark ? "light" : "dark";
        document.documentElement.dataset.theme = theme;
        localStorage.setItem(THEME_KEY, theme);
        setDark(!dark);
      }}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <circle
          cx="12"
          cy="12"
          r="8.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" />
      </svg>
      {dark ? "Light mode" : "Dark mode"}
    </button>
  );
}
