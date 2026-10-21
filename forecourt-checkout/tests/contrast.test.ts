import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Reads light-dark(<light>, <dark>) colour tokens from brand/tokens.css.
const css = readFileSync(
  path.resolve(import.meta.dirname, "../brand/tokens.css"),
  "utf8",
);
const tokens = Object.fromEntries(
  [
    ...css.matchAll(
      /--([\w-]+):\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/gi,
    ),
  ].map((m) => [m[1], { light: m[2], dark: m[3] }]),
);

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [text, background]: every pair the UI draws text with. `accent` is a fill
// only; it is never text on bg or surface.
const PAIRS = [
  ["ink", "bg"],
  ["ink", "surface"],
  ["muted", "bg"],
  ["muted", "surface"],
  ["on-accent", "accent"], // primary buttons, warn pills, skip link, nav
  ["ok", "bg"],
  ["ok", "surface"], // ready and paid pills
  ["danger", "bg"],
  ["danger", "surface"], // fault pills, errors
  ["on-danger", "danger"], // Stop charging
  ["pump-ink", "pump"], // demo banner, pump boards, countdown
] as const;

describe("brand tokens", () => {
  it("parses all colour tokens for light and dark", () => {
    expect(Object.keys(tokens).sort()).toEqual([
      "accent",
      "bg",
      "danger",
      "ink",
      "muted",
      "ok",
      "on-accent",
      "on-danger",
      "pump",
      "pump-ink",
      "surface",
    ]);
  });

  it("matches the WCAG reference values", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  for (const mode of ["light", "dark"] as const)
    for (const [fg, bg] of PAIRS)
      it(`${mode}: ${fg} on ${bg} meets AA (4.5:1)`, () => {
        const ratio = contrast(tokens[fg][mode], tokens[bg][mode]);
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      });
});
