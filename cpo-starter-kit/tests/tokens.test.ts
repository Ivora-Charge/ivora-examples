import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEME_COLOR } from "@/lib/theme";

describe("design tokens", () => {
  it("keeps the browser theme colour equal to --color-bg", () => {
    const css = readFileSync("app/tokens.css", "utf8");
    const bg = /--color-bg:\s*([^;]+);/.exec(css)?.[1].trim();
    expect(bg).toBeDefined();
    expect(THEME_COLOR.toLowerCase()).toBe(bg?.toLowerCase());
  });
});
