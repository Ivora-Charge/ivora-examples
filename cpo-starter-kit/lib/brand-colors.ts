// The operator's brand colour themes the kit's primary colour (buttons, links, focus)
// where it stays readable. Pure functions, used on the server (layout, actions) and in
// the browser (the brand form's live contrast check).

export type Mode = "light" | "dark";
type Pair = Record<Mode, string>;

/**
 * The kit's own colours from brand/tokens.css that a brand colour is checked against.
 * tests/brand-colors.test.ts fails if they differ, so a restyle changes both together.
 */
export const KIT_COLORS: Record<
  "bg" | "surface" | "text" | "textMuted" | "primary" | "onPrimary",
  Pair
> = {
  bg: { light: "#f2f5ec", dark: "#0b130e" },
  surface: { light: "#ffffff", dark: "#132019" },
  text: { light: "#10241a", dark: "#e7f1e9" },
  textMuted: { light: "#4a5e52", dark: "#9bb2a3" },
  primary: { light: "#17613a", dark: "#6fd394" },
  onPrimary: { light: "#ffffff", dark: "#06200f" },
};

/** WCAG AA for text, and the 3:1 the focus ring needs (implied by 4.5). */
export const AA_TEXT = 4.5;

export const HEX_COLOR = /^#[0-9a-f]{6}$/;

const rgb = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** color-mix(in srgb, a p, b), as the browser computes it. */
export function mix(a: string, p: number, b: string): string {
  const [x, y] = [rgb(a), rgb(b)];
  return `#${x
    .map((c, i) =>
      Math.round(c * p + y[i] * (1 - p))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function luminance(hex: string) {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Lower-case #rrggbb, or null for anything else. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return HEX_COLOR.test(v) ? v : null;
}

export interface ModeCheck {
  /** The brand colour replaces the kit's primary colour in this mode. */
  used: boolean;
  /** Lowest contrast of the colour as link text on the page and on cards. */
  textContrast: number;
  /** Lowest contrast of button text on the colour (and its hover shade). */
  buttonContrast: number;
  /** Text colour for buttons filled with the brand colour. */
  onPrimary: string;
}

export interface BrandCheck {
  color: string;
  light: ModeCheck;
  dark: ModeCheck;
  /** Against white: Ivora's driver pages use the colour for buttons and headings. */
  driverContrast: number;
}

function checkMode(color: string, mode: Mode): ModeCheck {
  const k = (n: keyof typeof KIT_COLORS) => KIT_COLORS[n][mode];
  // Links and the focus ring sit on the page and on cards.
  const textContrast = Math.min(
    contrast(color, k("bg")),
    contrast(color, k("surface")),
  );
  // Buttons: text on the colour and on its hover shade (tokens: 85% with text).
  const hover = mix(color, 0.85, k("text"));
  const candidates = ["#ffffff", k("text"), k("onPrimary"), "#000000"];
  const scored = candidates.map((c) => ({
    c,
    n: Math.min(contrast(c, color), contrast(c, hover)),
  }));
  const best = scored.reduce((a, b) => (b.n > a.n ? b : a));
  // Hover rows and badges tint the surface with 8% of the primary colour.
  const tint = mix(color, 0.08, k("surface"));
  const tintOk =
    contrast(k("text"), tint) >= AA_TEXT &&
    contrast(k("textMuted"), tint) >= AA_TEXT;
  return {
    used: textContrast >= AA_TEXT && best.n >= AA_TEXT && tintOk,
    textContrast,
    buttonContrast: best.n,
    onPrimary: best.c,
  };
}

/** How a brand colour would theme the kit, in light and dark mode. */
export function checkBrandColor(color: string): BrandCheck {
  const c = normalizeHex(color);
  if (!c) throw new Error("Brand colour must be #rrggbb");
  return {
    color: c,
    light: checkMode(c, "light"),
    dark: checkMode(c, "dark"),
    driverContrast: contrast(c, "#ffffff"),
  };
}

/**
 * CSS that swaps the kit's primary colour for the brand colour in each mode where it
 * passes WCAG AA, keeping the kit's own colour in the other. Null when neither passes.
 * The colour is validated as #rrggbb, so it is safe to put in a <style> element.
 * `html:root` outranks the `:root` rule in brand/tokens.css whatever the order.
 */
export function brandThemeCss(color: string | null | undefined): string | null {
  const c = normalizeHex(color);
  if (!c) return null;
  const check = checkBrandColor(c);
  if (!check.light.used && !check.dark.used) return null;
  const pick = (mode: Mode, brand: string, kit: string) =>
    check[mode].used ? brand : kit;
  const primary = `light-dark(${pick("light", c, KIT_COLORS.primary.light)}, ${pick("dark", c, KIT_COLORS.primary.dark)})`;
  const onPrimary = `light-dark(${pick("light", check.light.onPrimary, KIT_COLORS.onPrimary.light)}, ${pick("dark", check.dark.onPrimary, KIT_COLORS.onPrimary.dark)})`;
  return `html:root{--color-primary:${primary};--color-on-primary:${onPrimary}}`;
}

/** One line for the operator: where the colour is used, and why not elsewhere. */
export function describeBrandCheck(check: BrandCheck): string {
  const ratio = (n: number) => `${n.toFixed(1)}:1`;
  const mode = (m: Mode, label: string) =>
    check[m].used
      ? `${label} mode uses it (links ${ratio(check[m].textContrast)})`
      : `${label} mode keeps the kit's colour (links would be ${ratio(check[m].textContrast)}, buttons ${ratio(check[m].buttonContrast)}; AA needs 4.5:1)`;
  return `${mode("light", "Light")}. ${mode("dark", "Dark")}.`;
}
