import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { brand, cssVariables } from "@/brand";

const read = (path: string) =>
  readFileSync(join(__dirname, "..", path), "utf8");

describe("brand tokens", () => {
  it("are the same file in the server and the app (run npm run brand:sync)", () => {
    expect(read("../app/brand/tokens.json")).toBe(read("brand/tokens.json"));
  });

  it("become CSS variables for every token", () => {
    const css = cssVariables();
    expect(css).toContain(`--color-primary: ${brand.color.primary};`);
    expect(css).toContain("--color-demo-background:");
    expect(css).toContain(`--font-body: "Instrument Sans", system-ui`);
    expect(css).toContain("--space-md: 1rem;");
    expect(css).toContain(`--radius-md: ${brand.radius.md}px;`);
  });

  it("put the self-hosted brand fonts first in the font variables", () => {
    const css = cssVariables(brand, { heading: "'__Heading_abc'" });
    expect(css).toContain(
      `--font-heading: '__Heading_abc', "Bricolage Grotesque", system-ui`,
    );
    expect(css).toContain(`--font-body: "Instrument Sans", system-ui`);
  });

  it("load the brand fonts in the admin layout, with their licences", () => {
    const fonts = read("brand/fonts.ts");
    for (const file of [
      "bricolage-grotesque-latin-800-normal.woff2",
      "instrument-sans-latin-400-normal.woff2",
      "instrument-sans-latin-600-normal.woff2",
      "dm-mono-latin-500-normal.woff2",
    ]) {
      expect(fonts).toContain(`./fonts/${file}`);
      expect(existsSync(join(__dirname, "../brand/fonts", file))).toBe(true);
    }
    for (const family of ["bricolage-grotesque", "instrument-sans", "dm-mono"])
      expect(read(`brand/fonts/OFL-${family}.txt`)).toContain(
        "SIL Open Font License, Version 1.1",
      );
    expect(read("app/layout.tsx")).toContain(
      "cssVariables(brand, fontFamilies)",
    );
  });

  it("switch every colour in dark mode", () => {
    expect(Object.keys(brand.colorDark).sort()).toEqual(
      Object.keys(brand.color).sort(),
    );
    const dark = cssVariables().split("@media (prefers-color-scheme: dark)")[1];
    expect(dark).toContain(`--color-primary: ${brand.colorDark.primary};`);
    expect(dark).toContain(
      `--color-background: ${brand.colorDark.background};`,
    );
  });

  it("are the only source of colours in the stylesheet", () => {
    expect(read("app/globals.css")).not.toMatch(
      /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i,
    );
  });
});
