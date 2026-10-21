"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/brand/icons";
import { THEME_KEY } from "@/lib/theme";

/** Light/dark switch, labelled by what it does. Until it is used, the page follows the system setting. */
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
      className="button secondary theme-toggle"
      onClick={() => {
        const theme = dark ? "light" : "dark";
        document.documentElement.dataset.theme = theme;
        try {
          localStorage.setItem(THEME_KEY, theme);
        } catch {
          // Private mode: the choice lasts for this page only.
        }
        setDark(!dark);
      }}
    >
      <Icon name={dark ? "sun" : "moon"} />
      <span className="theme-label">{dark ? "Light mode" : "Dark mode"}</span>
    </button>
  );
}
