/**
 * The browser UI colour (the `theme-color` meta tag), which can't read CSS variables.
 * It is --color-bg from app/tokens.css; tests/tokens.test.ts fails if the two differ,
 * so a restyle changes tokens.css and this line together.
 */
export const THEME_COLOR = "#111214";
