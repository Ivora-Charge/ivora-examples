import { describe, expect, it } from "vitest";
import {
  printableBaseProblem,
  resolveQrBase,
  stickerUrl,
} from "@/lib/server/qr-base";
import { isStickerCode, newStickerCode } from "@/lib/sticker-codes";

// QR stickers point at the deployer's own stable https domain, never Ivora's, a
// hosting provider's default domain or a shortener (docs/conventions.md).

const live = (env: Record<string, string>) =>
  resolveQrBase({ env, demo: false, requestOrigin: "http://localhost:3000" });

describe("QR sticker URLs", () => {
  it("refuse printable codes until a stable https origin of your own is set", () => {
    expect(live({})).toMatchObject({ ok: false });
    for (const bad of [
      "http://charge.example.com",
      "https://kit-abc.vercel.app",
      "https://pay.ivoracharge.com",
      "https://ivoracharge.co",
      "https://bit.ly",
      "https://localhost",
      "https://203.0.113.7",
      "https://charge.example.com/stickers",
      "https://user:pw@charge.example.com",
      "not a url",
    ])
      expect(live({ PUBLIC_BASE_URL: bad })).toMatchObject({ ok: false });
    expect(live({ PUBLIC_BASE_URL: "https://Charge.Example.com/" })).toEqual({
      ok: true,
      base: "https://charge.example.com",
      demo: false,
    });
  });

  it("uses APP_URL when PUBLIC_BASE_URL is not set, and PUBLIC_BASE_URL first", () => {
    expect(live({ APP_URL: "https://ops.example.com" })).toMatchObject({
      ok: true,
      base: "https://ops.example.com",
    });
    expect(
      live({
        APP_URL: "https://ops.example.com",
        PUBLIC_BASE_URL: "https://charge.example.com",
      }),
    ).toMatchObject({ base: "https://charge.example.com" });
    // A vercel.app APP_URL is refused, not silently printed.
    expect(live({ APP_URL: "https://kit.vercel.app" })).toMatchObject({
      ok: false,
    });
  });

  it("never prints from a preview deployment", () => {
    expect(
      live({
        PUBLIC_BASE_URL: "https://charge.example.com",
        VERCEL_ENV: "preview",
      }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/preview/) });
  });

  it("lets demo mode use the current address, marked as demo", () => {
    expect(
      resolveQrBase({
        env: {},
        demo: true,
        requestOrigin: "http://localhost:3307",
      }),
    ).toEqual({ ok: true, base: "http://localhost:3307", demo: true });
  });

  it("puts a stable random code under /c/ and names the variable in problems", () => {
    expect(stickerUrl("https://charge.example.com/", "ABCD2345")).toBe(
      "https://charge.example.com/c/ABCD2345",
    );
    const codes = new Set(Array.from({ length: 200 }, newStickerCode));
    expect(codes.size).toBe(200);
    for (const c of codes) expect(isStickerCode(c)).toBe(true);
    expect(isStickerCode("ABCD0O1I")).toBe(false);
    expect(printableBaseProblem("http://x.example", "APP_URL")).toMatch(
      /^APP_URL/,
    );
  });
});
