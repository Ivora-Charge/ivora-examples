import { useEffect } from "react";
import { i18n } from "../i18n";
import { useTheme } from "../theme";

/**
 * Page-wide rules for the web build, from the brand tokens: the focus ring (3 px
 * `focus` colour, 3:1 or more against the page and every surface it sits on, checked
 * by a unit test; `focusOnPrimary` inside a `primary` fill marked `data-on-primary`), the page colour behind the app, and the page's language.
 */
export function WebStyles() {
  const { c, scheme } = useTheme();
  useEffect(() => {
    document.documentElement.lang = i18n.locale.split("-")[0] || "en";
    let el = document.getElementById(
      "brand-web-styles",
    ) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement("style");
      el.id = "brand-web-styles";
      document.head.appendChild(el);
    }
    el.textContent = [
      `:root{color-scheme:${scheme};}`,
      `html,body{background:${c.background};overflow-x:hidden;}`,
      `*:focus{outline:none;}`,
      `*:focus-visible{outline:3px solid ${c.focus} !important;outline-offset:2px;}`,
      `input:focus-visible{outline-offset:6px;}`,
      `[data-on-primary] :focus-visible{outline-color:${c.focusOnPrimary} !important;}`,
      `input::placeholder{color:${c.muted};opacity:1;}`,
      `.maplibregl-canvas:focus-visible{outline-offset:-3px;}`,
      `.maplibregl-marker:has(:focus-visible){z-index:3;}`,
      `@media (prefers-reduced-motion: reduce){*{transition:none !important;animation:none !important;}}`,
    ].join("\n");
    const meta =
      document.querySelector('meta[name="theme-color"]') ??
      document.head.appendChild(
        Object.assign(document.createElement("meta"), { name: "theme-color" }),
      );
    meta.setAttribute("content", c.background);
  }, [c, scheme]);
  return null;
}
