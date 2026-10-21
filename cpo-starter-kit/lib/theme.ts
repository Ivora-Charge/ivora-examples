/**
 * The browser UI colour (the `theme-color` meta tag), which can't read CSS variables.
 * These are the light and dark --color-bg from brand/tokens.css; tests/tokens.test.ts
 * fails if they differ, so a restyle changes tokens.css and these lines together.
 */
export const THEME_COLORS = { light: "#f2f5ec", dark: "#0b130e" };

/** localStorage key for the manual light/dark choice. */
export const THEME_KEY = "cpo-theme";
