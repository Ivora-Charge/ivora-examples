import tokens from "./tokens.json";

/** Brand tokens: the only place colours, fonts and sizes are defined. */
export const brand = tokens;
export type Brand = typeof tokens;

/** Font stacks for the web. `system` means the platform's own UI font. */
const FONT_STACKS: Record<string, string> = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  monospace: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
};
export function fontStack(name: string): string {
  return FONT_STACKS[name] ?? `${JSON.stringify(name)}, ${FONT_STACKS.system}`;
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const colors = (palette: Record<string, string>) =>
  Object.entries(palette)
    .map(([k, v]) => `--color-${kebab(k)}: ${v};`)
    .join("");

/**
 * The tokens as CSS custom properties (`--color-primary`, `--space-md`, ...), set on
 * `:root` by the root layout. Stylesheets use only these variables. `colorDark`
 * replaces the colours when the device is in dark mode. `loaded` puts the
 * self-hosted fonts (brand/fonts.ts) first in each `--font-*` stack.
 */
export function cssVariables(
  b: Brand = brand,
  loaded: Partial<Record<string, string>> = {},
): string {
  const lines: string[] = [colors(b.color)];
  for (const [k, v] of Object.entries(b.font)) {
    const stack = fontStack(v);
    lines.push(
      `--font-${kebab(k)}: ${loaded[k] ? `${loaded[k]}, ${stack}` : stack};`,
    );
  }
  for (const [k, v] of Object.entries(b.fontSize))
    lines.push(`--font-size-${k}: ${v / 16}rem;`);
  for (const [k, v] of Object.entries(b.fontWeight))
    lines.push(`--font-weight-${k}: ${v};`);
  for (const [k, v] of Object.entries(b.space))
    lines.push(`--space-${k}: ${v / 16}rem;`);
  for (const [k, v] of Object.entries(b.radius))
    lines.push(`--radius-${k}: ${v}px;`);
  lines.push(`--min-tap-target: ${b.minTapTarget}px;`);
  return (
    `:root{color-scheme:light dark;${lines.join("")}}` +
    `@media (prefers-color-scheme: dark){:root{${colors(b.colorDark)}}}`
  );
}
