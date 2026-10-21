import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEME_COLORS } from "@/lib/theme";

describe("design tokens", () => {
  it("keeps the browser theme colours equal to --color-bg in light and dark", () => {
    const css = readFileSync("brand/tokens.css", "utf8");
    const bg = /--color-bg:\s*light-dark\((#\w+),\s*(#\w+)\)/.exec(css);
    expect(bg).not.toBeNull();
    expect(THEME_COLORS.light.toLowerCase()).toBe(bg?.[1].toLowerCase());
    expect(THEME_COLORS.dark.toLowerCase()).toBe(bg?.[2].toLowerCase());
  });
});
