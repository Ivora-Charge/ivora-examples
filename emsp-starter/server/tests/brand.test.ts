import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
