import tokens from "./tokens.json";

/**
 * Brand tokens: the only place colours, fonts and sizes are defined. This file is a
 * copy of ../server/brand/tokens.json, kept in sync by `npm run brand:sync` there.
 */
export const brand = tokens;
export type Brand = typeof tokens;
export type Palette = Brand["color"];
export type Scheme = "light" | "dark";
export const space = tokens.space;
export const radius = tokens.radius;
export const fontSize = tokens.fontSize;

/** The colours of light or dark mode. */
export const palette = (scheme: Scheme): Palette =>
  scheme === "dark" ? tokens.colorDark : tokens.color;

/** WCAG 2.x contrast ratio of two `#rrggbb` colours, from 1 to 21. */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
