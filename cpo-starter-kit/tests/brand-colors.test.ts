import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  brandThemeCss,
  checkBrandColor,
  contrast,
  describeBrandCheck,
  describeDriverColor,
  driverPageColor,
  KIT_COLORS,
  mix,
  normalizeHex,
} from "@/lib/brand-colors";

const css = readFileSync("brand/tokens.css", "utf8");
const token = (name: string) => {
  const m = new RegExp(
    `--color-${name}:\\s*light-dark\\((#[0-9a-f]{6}),\\s*(#[0-9a-f]{6})\\)`,
    "i",
  ).exec(css);
  if (!m) throw new Error(`--color-${name} not found`);
  return { light: m[1].toLowerCase(), dark: m[2].toLowerCase() };
};

describe("brand colour theming", () => {
  it("checks against the same colours as brand/tokens.css", () => {
    expect(KIT_COLORS).toEqual({
      bg: token("bg"),
      surface: token("surface"),
      text: token("text"),
      textMuted: token("text-muted"),
      primary: token("primary"),
      onPrimary: token("on-primary"),
    });
  });

  it("computes WCAG contrast and colour mixes like the browser", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(mix("#000000", 0.5, "#ffffff")).toBe("#808080");
  });

  it("accepts the kit's own primary colour in light mode", () => {
    const c = checkBrandColor(KIT_COLORS.primary.light);
    expect(c.light.used).toBe(true);
    expect(c.light.onPrimary).toBe("#ffffff");
    expect(c.light.textContrast).toBeGreaterThanOrEqual(4.5);
    expect(c.light.buttonContrast).toBeGreaterThanOrEqual(4.5);
  });

  it("uses a dark brand colour in light mode only, and keeps the kit's in dark mode", () => {
    const c = checkBrandColor("#1d3fa8");
    expect(c.light.used).toBe(true);
    expect(c.dark.used).toBe(false);
    const theme = brandThemeCss("#1D3FA8");
    expect(theme).toBe(
      `html:root{--color-primary:light-dark(#1d3fa8, ${KIT_COLORS.primary.dark});--color-on-primary:light-dark(#ffffff, ${KIT_COLORS.onPrimary.dark})}`,
    );
    expect(describeBrandCheck(c)).toMatch(
      /^Light mode uses it .*Dark mode keeps the kit's colour/,
    );
  });

  it("uses a light brand colour in dark mode only, with dark text on buttons", () => {
    const c = checkBrandColor("#7cc4ff");
    expect(c.light.used).toBe(false);
    expect(c.dark.used).toBe(true);
    expect(contrast(c.dark.onPrimary, "#7cc4ff")).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the kit's colours when the brand colour can't be read in either mode", () => {
    // Mid grey: too light for text on white, too dark on the night canopy.
    const c = checkBrandColor("#808080");
    expect(c.light.used || c.dark.used).toBe(false);
    expect(brandThemeCss("#808080")).toBeNull();
  });

  it("never puts anything but a #rrggbb colour into the stylesheet", () => {
    for (const bad of [
      "red",
      "#fff",
      "#12345g",
      "#123456;}body{display:none",
      "</style><script>",
      null,
      undefined,
    ])
      expect(brandThemeCss(bad)).toBeNull();
    expect(normalizeHex(" #ABCDEF ")).toBe("#abcdef");
    expect(() => checkBrandColor("blue")).toThrow();
  });

  it("only themes with colours that pass AA everywhere they are used", () => {
    // Sample the colour space: every colour the theme uses must pass in that mode.
    for (let i = 0; i < 4096; i += 7) {
      const hex = `#${[(i >> 8) & 15, (i >> 4) & 15, i & 15]
        .map((n) => (n * 17).toString(16).padStart(2, "0"))
        .join("")}`;
      const c = checkBrandColor(hex);
      for (const mode of ["light", "dark"] as const) {
        if (!c[mode].used) continue;
        const k = (n: keyof typeof KIT_COLORS) => KIT_COLORS[n][mode];
        expect(contrast(hex, k("bg"))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(hex, k("surface"))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(c[mode].onPrimary, hex)).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(c[mode].onPrimary, mix(hex, 0.85, k("text"))),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(k("text"), mix(hex, 0.08, k("surface"))),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("never sends the driver pages a colour below 3:1 on white", () => {
    // Yellow is about 1.1:1 on white: the driver pages get a darker shade of it.
    const shade = driverPageColor("#ffff00");
    expect(contrast("#ffff00", "#ffffff")).toBeLessThan(1.2);
    expect(contrast(shade, "#ffffff")).toBeGreaterThanOrEqual(3);
    expect(contrast(shade, "#ffffff")).toBeLessThan(3.2); // as light as allowed
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(shade.slice(i, i + 2), 16));
    expect(r).toBe(g); // same hue
    expect(b).toBe(0);
    const check = checkBrandColor("#FFFF00");
    expect(check.driverColor).toBe(shade);
    expect(describeDriverColor(check)).toMatch(
      new RegExp(`only 1\\.1:1 on white .*darker shade ${shade}`),
    );
    // A readable colour goes as it is.
    expect(driverPageColor("#17613a")).toBe("#17613a");
    expect(describeDriverColor(checkBrandColor("#17613a"))).toMatch(
      /^Driver pages: \d+\.\d:1 on white\.$/,
    );
    for (let i = 0; i < 4096; i += 11) {
      const hex = `#${[(i >> 8) & 15, (i >> 4) & 15, i & 15]
        .map((n) => (n * 17).toString(16).padStart(2, "0"))
        .join("")}`;
      expect(contrast(driverPageColor(hex), "#ffffff")).toBeGreaterThanOrEqual(
        3,
      );
    }
  });
});
