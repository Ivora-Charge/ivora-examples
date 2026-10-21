import tokens from "./tokens.json";

/**
 * Brand tokens: the only place colours, fonts and sizes are defined. This file is a
 * copy of ../server/brand/tokens.json, kept in sync by `npm run brand:sync` there.
 */
export const brand = tokens;
export type Brand = typeof tokens;
export const color = tokens.color;
export const space = tokens.space;
export const radius = tokens.radius;
export const fontSize = tokens.fontSize;

type Weight = "400" | "700";
export const fontWeight = tokens.fontWeight as Record<
  keyof Brand["fontWeight"],
  Weight
>;

const WEB_STACKS: Record<string, string> = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  monospace: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
};

/**
 * A font token as a React Native `fontFamily`. `system` means the platform's own UI
 * font, which is `undefined` on iOS and Android. Custom fonts must be loaded with
 * expo-font under the same name.
 */
export function fontFamily(name: string, platform: string): string | undefined {
  if (platform === "web") return WEB_STACKS[name] ?? name;
  if (name === "system") return undefined;
  return name;
}
