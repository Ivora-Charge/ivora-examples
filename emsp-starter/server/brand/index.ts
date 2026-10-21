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

/**
 * The tokens as CSS custom properties (`--color-primary`, `--space-md`, ...), set on
 * `:root` by the root layout. Stylesheets use only these variables.
 */
export function cssVariables(b: Brand = brand): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(b.color))
    lines.push(`--color-${kebab(k)}: ${v};`);
  for (const [k, v] of Object.entries(b.font))
    lines.push(`--font-${kebab(k)}: ${fontStack(v)};`);
  for (const [k, v] of Object.entries(b.fontSize))
    lines.push(`--font-size-${k}: ${v / 16}rem;`);
  for (const [k, v] of Object.entries(b.fontWeight))
    lines.push(`--font-weight-${k}: ${v};`);
  for (const [k, v] of Object.entries(b.space))
    lines.push(`--space-${k}: ${v / 16}rem;`);
  for (const [k, v] of Object.entries(b.radius))
    lines.push(`--radius-${k}: ${v}px;`);
  lines.push(`--min-tap-target: ${b.minTapTarget}px;`);
  return `:root{${lines.join("")}}`;
}
