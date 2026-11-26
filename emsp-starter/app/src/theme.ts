import { useMemo } from "react";
import {
  Platform,
  useColorScheme,
  useWindowDimensions,
  type TextStyle,
} from "react-native";
import { brand, palette, space, type Palette, type Scheme } from "../brand";

export { brand, fontSize, radius, space } from "../brand";
export type { Palette, Scheme };

const web = Platform.OS === "web";

/**
 * Font names. On iOS and Android each weight is its own family, loaded by `useBrandFonts`
 * under these names; on the web the system font stands in until the brand font loads.
 */
export const FONT = {
  heading: brand.font.heading,
  body: brand.font.body,
  bodyMedium: `${brand.font.body} Medium`,
  bodyStrong: `${brand.font.body} SemiBold`,
  mono: brand.font.mono,
};

const stack = (name: string, fallback: string) =>
  web ? `"${name}", ${fallback}` : name;
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

/** Text styles by role: family, and weight on the web (native families carry their weight). */
export const type: Record<
  "heading" | "body" | "medium" | "strong" | "mono",
  TextStyle
> = {
  heading: {
    fontFamily: stack(FONT.heading, SANS),
    ...(web
      ? { fontWeight: brand.fontWeight.heavy as TextStyle["fontWeight"] }
      : {}),
  },
  body: { fontFamily: stack(FONT.body, SANS) },
  medium: {
    fontFamily: stack(FONT.bodyMedium, SANS),
    ...(web
      ? { fontWeight: brand.fontWeight.medium as TextStyle["fontWeight"] }
      : {}),
  },
  strong: {
    fontFamily: stack(FONT.bodyStrong, SANS),
    ...(web
      ? { fontWeight: brand.fontWeight.semibold as TextStyle["fontWeight"] }
      : {}),
  },
  mono: { fontFamily: stack(FONT.mono, MONO) },
};

/**
 * Sizes that follow the driver's text size. On the web they are rem, so the browser's
 * font size setting and zoom scale them; on iOS and Android text scales by itself
 * (Dynamic Type, font scale), and `dim` scales boxes that hold text, such as status
 * tiles, by the same factor.
 */
export function useScale() {
  const { fontScale } = useWindowDimensions();
  return useMemo(
    () => ({
      /** A font size. */
      fs: (px: number) => (web ? (`${px / 16}rem` as unknown as number) : px),
      /** A box size that grows with the text inside it. */
      dim: (px: number) =>
        web
          ? (`${px / 16}rem` as unknown as number)
          : px * Math.max(1, fontScale),
    }),
    [fontScale],
  );
}

/** The colours of the device's light or dark mode. */
export function useTheme(): { scheme: Scheme; c: Palette } {
  const scheme: Scheme = useColorScheme() === "dark" ? "dark" : "light";
  return useMemo(() => ({ scheme, c: palette(scheme) }), [scheme]);
}

/**
 * Wide screens get the desktop layout: a list panel beside the map. Narrower ones get
 * the phone layout, with its denser type and spacing.
 */
export const WIDE_MIN = 900;
export function useWide(): boolean {
  return useWindowDimensions().width >= WIDE_MIN;
}

/** The side padding of the phone's sheet, which the chip row scrolls across. */
export const SHEET_PADDING = space.sm + space.xs;

/** The soft two-layer shadow of floating things: markers, the sheet, the detail card. */
export const elevation = (c: Palette, strong = false) => ({
  boxShadow: strong
    ? `0 2px 4px ${c.shadow}29, 0 16px 40px ${c.shadow}33`
    : `0 1px 2px ${c.shadow}24, 0 8px 24px ${c.shadow}24`,
});
