import { describe, expect, it } from "vitest";
import { brand, fontFamily } from "../brand";

describe("brand tokens", () => {
  it("define every colour the app uses as a hex value", () => {
    for (const v of Object.values(brand.color))
      expect(v).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("map the system font to the platform default", () => {
    expect(fontFamily("system", "ios")).toBeUndefined();
    expect(fontFamily("system", "android")).toBeUndefined();
    expect(fontFamily("system", "web")).toContain("system-ui");
    expect(fontFamily("Inter", "ios")).toBe("Inter");
  });
});
