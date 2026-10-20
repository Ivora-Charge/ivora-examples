import { describe, expect, it } from "vitest";
import { isStickerCode, newStickerCode } from "@/lib/codes";
import { qrPng, qrSvg } from "@/lib/qr";
import {
  assertNotIvoraDomain,
  isIvoraHost,
  printableBaseProblem,
  resolveQrBase,
  stickerUrl,
} from "@/lib/urls";

describe("Ivora domain guard", () => {
  it.each([
    "https://ivoracharge.com",
    "https://ivoracharge.co",
    "https://app.ivoracharge.com",
    "https://a.b.ivoracharge.co/path",
    "https://IVORACHARGE.COM",
    "https://ivoracharge.com./x",
  ])("rejects %s", (url) => {
    expect(() => assertNotIvoraDomain(url)).toThrow(/not an Ivora domain/);
    expect(printableBaseProblem(url)).toMatch(/Ivora/);
  });

  it.each([
    "https://charge.example.com",
    "https://notivoracharge.com",
    "https://ivoracharge.com.example.com",
    "https://ivoracharge.company",
  ])("allows %s", (url) => {
    expect(() => assertNotIvoraDomain(url)).not.toThrow();
  });

  it("matches hosts exactly or by subdomain", () => {
    expect(isIvoraHost("ivoracharge.com")).toBe(true);
    expect(isIvoraHost("x.ivoracharge.co")).toBe(true);
    expect(isIvoraHost("myivoracharge.co")).toBe(false);
  });
});

describe("printable QR base", () => {
  it.each([
    ["http://charge.example.com", /https/],
    ["https://localhost:3000", /localhost/],
    ["https://127.0.0.1", /IP/],
    ["https://my-app.vercel.app", /domain you own/],
    ["https://preview-123.my-app.vercel.app", /domain you own/],
    ["https://bit.ly", /domain you own/],
    ["https://user:pw@charge.example.com", /credentials/],
    ["https://charge.example.com/?x=1", /query/],
    ["not a url", /valid URL/],
  ])("refuses %s", (url, reason) => {
    expect(printableBaseProblem(url)).toMatch(reason);
  });

  it("accepts a stable HTTPS origin, with or without a path", () => {
    expect(printableBaseProblem("https://charge.example.com")).toBeNull();
    expect(printableBaseProblem("https://example.com/charge")).toBeNull();
  });

  it("refuses printable codes in live mode until QR_BASE_URL is set", () => {
    const r = resolveQrBase({
      env: {},
      demo: false,
      requestOrigin: "https://my-app.vercel.app",
    });
    expect(r.ok).toBe(false);
  });

  it("never falls back to the request host in live mode", () => {
    const r = resolveQrBase({
      env: { QR_BASE_URL: "" },
      demo: false,
      requestOrigin: "https://charge.example.com",
    });
    expect(r.ok).toBe(false);
  });

  it("uses QR_BASE_URL in live mode and trims trailing slashes", () => {
    expect(
      resolveQrBase({
        env: { QR_BASE_URL: " https://charge.example.com// " },
        demo: false,
        requestOrigin: "http://localhost:3000",
      }),
    ).toEqual({ ok: true, base: "https://charge.example.com", demo: false });
  });

  it("refuses a bad QR_BASE_URL even in demo mode", () => {
    const r = resolveQrBase({
      env: { QR_BASE_URL: "https://app.ivoracharge.com" },
      demo: true,
      requestOrigin: "http://localhost:3000",
    });
    expect(r.ok).toBe(false);
  });

  it("lets demo mode use the current origin, marked as demo", () => {
    expect(
      resolveQrBase({
        env: {},
        demo: true,
        requestOrigin: "http://localhost:3000/",
      }),
    ).toEqual({ ok: true, base: "http://localhost:3000", demo: true });
  });
});

describe("sticker codes and URLs", () => {
  it("generates random, readable codes", () => {
    const codes = new Set(Array.from({ length: 500 }, newStickerCode));
    expect(codes.size).toBe(500);
    for (const c of codes) {
      expect(isStickerCode(c)).toBe(true);
      expect(c).not.toMatch(/[01IO]/);
    }
    expect(isStickerCode("abc")).toBe(false);
    expect(isStickerCode("ABCDEFG0")).toBe(false);
  });

  it("puts the code, not a station ID, in the path", () => {
    expect(stickerUrl("https://charge.example.com/", "ABCD2345")).toBe(
      "https://charge.example.com/s/ABCD2345",
    );
  });
});

describe("QR generation", () => {
  it("renders SVG and PNG", async () => {
    const svg = await qrSvg("https://charge.example.com/s/ABCD2345");
    expect(svg).toContain("<svg");
    const png = await qrPng("https://charge.example.com/s/ABCD2345");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
  });

  it("encodes longer text into a larger symbol", async () => {
    const short = await qrSvg("https://x.test/s/ABCD2345");
    const long = await qrSvg(`https://x.test/s/${"A".repeat(200)}`);
    const size = (svg: string) => Number(/viewBox="0 0 (\d+)/.exec(svg)?.[1]);
    expect(size(long)).toBeGreaterThan(size(short));
  });
});
