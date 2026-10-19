import { describe, expect, it } from "vitest";
import {
  maskSecret,
  firstDisplay,
  afterFirstDisplay,
  generatePassword,
} from "@/lib/credentials";
import {
  assertNotIvoraDomain,
  ocppConnectionUrl,
  qrBase,
  stickerUrl,
} from "@/lib/urls";
import { qrSvg, qrPng } from "@/lib/qr";
import { describe as describeStatus, mapEvent } from "@/lib/status";
import { reportPdf, stickerPdf } from "@/lib/pdf";
import { demoState, demoTest, DEMO_BOOT } from "@/lib/demo";
import { quoteCents } from "@/lib/tariff";
import { signBody, verifySignature } from "@/lib/webhook";
import type { Charger } from "@/lib/types";

const head = (b: Uint8Array) => Buffer.from(b.slice(0, 5)).toString();

describe("urls", () => {
  it("defaults QR base to a local, non-Ivora domain and trims slashes", () => {
    expect(qrBase({})).toBe("http://localhost:3000");
    expect(qrBase({ QR_BASE_URL: "https://charge.example.com//" })).toBe(
      "https://charge.example.com",
    );
  });
  it("builds sticker and OCPP URLs", () => {
    expect(stickerUrl("a b", 2, "https://x.test")).toBe(
      "https://x.test/c/a%20b/2",
    );
    expect(ocppConnectionUrl("wss://h.test/ocpp/", "st-1")).toBe(
      "wss://h.test/ocpp/st-1",
    );
  });
  it("rejects Ivora domains", () => {
    expect(() => assertNotIvoraDomain("https://app.ivora.io")).toThrow();
    expect(() =>
      assertNotIvoraDomain("https://charge.example.com"),
    ).not.toThrow();
  });
});

describe("qr", () => {
  it("generates svg and png", async () => {
    expect(await qrSvg("https://x.test")).toContain("<svg");
    expect((await qrPng("https://x.test")).subarray(1, 4).toString()).toBe(
      "PNG",
    );
  });
});

describe("credentials", () => {
  it("shows the password once, then only a mask", () => {
    const pw = generatePassword();
    const c = { stationId: "s", password: pw };
    expect(firstDisplay(c).password).toBe(pw);
    const later = afterFirstDisplay(c);
    expect(later.password).toBeNull();
    expect(JSON.stringify(later)).not.toContain(pw);
    expect(maskSecret("abc")).toHaveLength(8);
  });
});

describe("status", () => {
  it("maps events", () => {
    expect(mapEvent("station.connected")).toBe("connected");
    expect(mapEvent("station.booted")).toBe("booted");
    expect(mapEvent("other")).toBeNull();
  });
  it("gives hints after a long wait or disconnect", () => {
    expect(describeStatus("waiting", 5).hint).toBeUndefined();
    expect(describeStatus("waiting", 90).hint).toContain("Wrong URL");
    expect(describeStatus("offline", 0).hint).toBeDefined();
  });
});

describe("demo and tariff", () => {
  it("connects over time and passes the test", () => {
    const t0 = new Date().toISOString();
    expect(demoState(t0, Date.parse(t0))).toBe("waiting");
    expect(demoState(t0, Date.parse(t0) + 10_000)).toBe("booted");
    expect(demoTest().passed).toBe(true);
  });
  it("quotes in integer cents", () => expect(quoteCents(0.42, 35)).toBe(15));
});

describe("webhook", () => {
  it("verifies signatures", () => {
    const sig = signBody("{}", "s");
    expect(verifySignature("{}", sig, "s")).toBe(true);
    expect(verifySignature("{}", sig, "other")).toBe(false);
    expect(verifySignature("{}", null, "s")).toBe(false);
  });
});

describe("pdfs", () => {
  it("renders sticker and report", async () => {
    expect(
      head(
        await stickerPdf({
          url: "https://x.test/c/1/1",
          siteName: "S",
          connectorLabel: "Connector 1",
        }),
      ),
    ).toBe("%PDF-");
    const charger: Charger = {
      id: "demo-1",
      siteId: "s",
      name: "C",
      createdAt: "",
      demo: true,
      passwordMasked: "••••••••",
      state: "booted",
      boot: DEMO_BOOT,
      test: demoTest(),
    };
    const pdf = await reportPdf({
      charger,
      site: { id: "s", name: "Site", address: "1 Main St" },
    });
    expect(head(pdf)).toBe("%PDF-");
  });
});
