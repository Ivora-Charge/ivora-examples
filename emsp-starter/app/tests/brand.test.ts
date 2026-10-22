import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { brand, contrast, palette, type Scheme } from "../brand";

const SCHEMES: Scheme[] = ["light", "dark"];

/** Text on the surfaces it sits on: WCAG AA (4.5:1) in both modes. */
const TEXT_PAIRS: [string, string][] = [
  ["text", "background"],
  ["text", "surface"],
  ["text", "tint"],
  ["muted", "background"],
  ["muted", "surface"],
  ["primary", "background"],
  ["primary", "surface"],
  ["primary", "tint"],
  ["onPrimary", "primary"],
  ["onFlare", "flare"],
  ["flare", "onFlare"],
  ["demoText", "demoBackground"],
  ["onStatus", "free"],
  ["free", "background"],
  ["free", "surface"],
  ["busy", "background"],
  ["busy", "surface"],
  ["danger", "background"],
  ["danger", "surface"],
  ["onDanger", "danger"],
  ["text", "mapLand"],
];

/**
 * The focus ring: 3:1 against everything it can touch (WCAG 2.2, 2.4.13 and 1.4.11).
 * On a `primary` fill (the charger header) the ring is `focusOnPrimary`.
 */
const FOCUS_NEIGHBOURS = [
  "background",
  "surface",
  "tint",
  "mapLand",
  "primary",
];
const ringOn = (n: string) => (n === "primary" ? "focusOnPrimary" : "focus");

describe("brand tokens", () => {
  it("define every colour as a hex value, with the same keys in light and dark", () => {
    for (const s of SCHEMES)
      for (const v of Object.values(palette(s)))
        expect(v).toMatch(/^#[0-9a-f]{6}$/i);
    expect(Object.keys(brand.colorDark).sort()).toEqual(
      Object.keys(brand.color).sort(),
    );
  });

  it.each(SCHEMES)("meet WCAG AA for every text pair in %s mode", (s) => {
    const c = palette(s) as Record<string, string>;
    const low = TEXT_PAIRS.map(([fg, bg]) => ({
      fg,
      bg,
      ratio: contrast(c[fg], c[bg]),
    }))
      .filter((p) => p.ratio < 4.5)
      .map((p) => `${p.fg} on ${p.bg}: ${p.ratio.toFixed(2)}`);
    expect(low).toEqual([]);
  });

  it.each(SCHEMES)(
    "give the focus ring 3:1 against what it touches in %s mode",
    (s) => {
      const c = palette(s) as Record<string, string>;
      for (const n of FOCUS_NEIGHBOURS)
        expect(
          contrast(c[ringOn(n)], c[n]),
          `${ringOn(n)} on ${n}`,
        ).toBeGreaterThanOrEqual(3);
    },
  );

  it.each(SCHEMES)(
    "keep the selected charger's ring apart from the focus ring in %s mode",
    (s) => {
      const c = palette(s);
      expect(c.selected).not.toBe(c.focus);
      expect(contrast(c.selected, c.focus)).toBeGreaterThanOrEqual(1.5);
    },
  );

  it("keep the flare yellow off the light page as text (it is a fill or a ring there)", () => {
    expect(contrast(brand.color.flare, brand.color.background)).toBeLessThan(3);
    expect(brand.color.focus).not.toBe(brand.color.flare);
  });

  it("keep every text size at 12 px or more, and every size a token", () => {
    expect(Math.min(...Object.values(brand.fontSize))).toBeGreaterThanOrEqual(
      12,
    );
    const literal = files(join(__dirname, "../src")).filter((f) =>
      /fontSize:\s*(fs\()?\d/.test(readFileSync(f, "utf8")),
    );
    expect(literal).toEqual([]);
  });

  it("measure contrast the WCAG way", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
