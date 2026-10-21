import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const css = readFileSync(path.join(root, "brand/tokens.css"), "utf8");

// --color-<name>: light-dark(<light>, <dark>) from brand/tokens.css.
const tokens = Object.fromEntries(
  [
    ...css.matchAll(
      /--color-([\w-]+):\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/gi,
    ),
  ].map((m) => [m[1], { light: m[2], dark: m[3] }]),
);
type Mode = "light" | "dark";

const rgb = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** color-mix(in srgb, a p%, b), as the browser computes it. */
function mix(a: string, p: number, b: string) {
  const [x, y] = [rgb(a), rgb(b)];
  return `#${x
    .map((c, i) =>
      Math.round(c * p + y[i] * (1 - p))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

// The mixed colours tokens.css derives with color-mix().
function color(name: string, mode: Mode): string {
  const t = (n: string) => tokens[n][mode];
  const derived: Record<string, () => string> = {
    "surface-hover": () => mix(t("primary"), 0.08, t("surface")),
    "ok-bg": () => mix(t("ok"), 0.12, t("surface")),
    "warn-bg": () => mix(t("warn"), 0.12, t("surface")),
    "danger-bg": () => mix(t("danger"), 0.12, t("surface")),
    "input-border": () => mix(t("text"), 0.5, t("surface")),
    "primary-hover": () => mix(t("primary"), 0.85, t("text")),
  };
  return derived[name]?.() ?? t(name);
}

function luminance(hex: string) {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [text, background]: every pair the UI draws text with (4.5:1).
const TEXT_PAIRS = [
  ["text", "bg"],
  ["text", "surface"],
  ["text-muted", "bg"],
  ["text-muted", "surface"],
  ["primary", "bg"], // links
  ["primary", "surface"],
  ["on-primary", "primary"], // primary buttons, skip link
  ["on-primary", "primary-hover"],
  ["on-accent", "accent"], // current page, demo chip
  ["ok", "bg"],
  ["ok", "surface"],
  ["warn", "bg"],
  ["warn", "surface"],
  ["danger", "bg"],
  ["danger", "surface"], // remove buttons
  ["text", "surface-hover"], // demo banner, badges, hover rows
  ["text-muted", "surface-hover"],
  ["text", "ok-bg"], // success, online pill
  ["text", "warn-bg"], // notices
  ["text", "danger-bg"], // errors, offline pill
] as const;

// [shape, background]: borders and focus rings that must be seen (3:1).
const UI_PAIRS = [
  ["input-border", "surface"],
  ["primary", "bg"], // focus ring
  ["primary", "surface"],
] as const;

describe("brand tokens", () => {
  it("parses all colour tokens for light and dark", () => {
    expect(Object.keys(tokens).sort()).toEqual([
      "accent",
      "bg",
      "danger",
      "ok",
      "on-accent",
      "on-primary",
      "primary",
      "surface",
      "text",
      "text-muted",
      "warn",
    ]);
  });

  it("matches the WCAG reference values", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(mix("#000000", 0.5, "#ffffff")).toBe("#808080");
  });

  for (const mode of ["light", "dark"] as const) {
    for (const [fg, bg] of TEXT_PAIRS)
      it(`${mode}: ${fg} on ${bg} meets AA (4.5:1)`, () => {
        expect(
          contrast(color(fg, mode), color(bg, mode)),
        ).toBeGreaterThanOrEqual(4.5);
      });
    for (const [fg, bg] of UI_PAIRS)
      it(`${mode}: ${fg} against ${bg} meets 3:1 for UI`, () => {
        expect(
          contrast(color(fg, mode), color(bg, mode)),
        ).toBeGreaterThanOrEqual(3);
      });
  }
});

// Lime marks what is current or live, and is fill only (see brand/tokens.css).
describe("lime accent is fill only", () => {
  const files = ["app", "brand"].flatMap((dir) =>
    readdirSync(path.join(root, dir), { recursive: true, encoding: "utf8" })
      .filter((f) => /\.(css|tsx)$/.test(f))
      .map((f) => path.join(dir, f)),
  );
  const source = (f: string) => readFileSync(path.join(root, f), "utf8");

  it("is unreadable as text on bg and surface in light mode", () => {
    for (const bg of ["bg", "surface"])
      expect(contrast(tokens.accent.light, tokens[bg].light)).toBeLessThan(3);
  });

  it("is never used as a text colour", () => {
    const asText =
      /(?:^|[\s;{"'])(?:color|caret-color|-webkit-text-fill-color|text-decoration-color)\s*:\s*["']?[^;}"']*var\(--color-accent\)/m;
    const offenders = files.filter((f) => asText.test(source(f)));
    expect(offenders).toEqual([]);
  });

  it("always carries --color-on-accent text where it is a background", () => {
    const rules = files
      .filter((f) => f.endsWith(".css"))
      .flatMap((f) => source(f).split("}"))
      .map((block) => block.slice(block.lastIndexOf("{") + 1))
      .filter((decls) =>
        /background(-color)?:\s*var\(--color-accent\)/.test(decls),
      );
    expect(rules.length).toBeGreaterThan(0);
    for (const decls of rules)
      expect(decls).toMatch(/(^|[\s;])color:\s*var\(--color-on-accent\)/);
  });
});
