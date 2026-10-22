import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, OPENFREEMAP_ORIGIN } from "../scripts/csp.mjs";
import { OPENFREEMAP } from "../src/lib/map-style";

const directive = (policy: string, name: string) =>
  policy
    .split("; ")
    .find((d) => d.startsWith(`${name} `))
    ?.split(" ")
    .slice(1);

describe("the web build's Content-Security-Policy", () => {
  it("allows scripts only from the site, never inline or eval", () => {
    const p = contentSecurityPolicy({});
    expect(directive(p, "script-src")).toEqual(["'self'"]);
    expect(directive(p, "object-src")).toEqual(["'none'"]);
    expect(p).not.toMatch(/unsafe-eval/);
  });

  it("offline demo: requests go only to the site and the keyless map tiles", () => {
    expect(directive(contentSecurityPolicy({}), "connect-src")).toEqual([
      "'self'",
      OPENFREEMAP_ORIGIN,
    ]);
    expect(OPENFREEMAP.tiles.startsWith(OPENFREEMAP_ORIGIN)).toBe(true);
    expect(OPENFREEMAP.glyphs.startsWith(OPENFREEMAP_ORIGIN)).toBe(true);
  });

  it("adds the configured server and the map provider, as origins only", () => {
    const p = contentSecurityPolicy({
      EXPO_PUBLIC_API_URL: "https://emsp.example/",
      EXPO_PUBLIC_MAP_STYLE_URL: "https://maps.example/styles/day.json?key=pub",
      EXPO_PUBLIC_MAP_STYLE_URL_DARK: "https://maps.example/styles/night.json",
      MAP_CONNECT_SRC: "https://tiles.maps.example  javascript:alert(1) *",
    });
    expect(directive(p, "connect-src")).toEqual([
      "'self'",
      "https://emsp.example",
      "https://maps.example",
      "https://tiles.maps.example",
    ]);
  });

  it("drops the map hosts when the map draws no tiles", () => {
    expect(
      directive(
        contentSecurityPolicy({ EXPO_PUBLIC_MAP_STYLE_URL: "none" }),
        "connect-src",
      ),
    ).toEqual(["'self'"]);
  });

  it("refuses plain http except for a local server", () => {
    const p = (url: string) =>
      directive(
        contentSecurityPolicy({ EXPO_PUBLIC_API_URL: url }),
        "connect-src",
      );
    expect(p("http://emsp.example")).not.toContain("http://emsp.example");
    expect(p("http://localhost:3000")).toContain("http://localhost:3000");
  });
});
