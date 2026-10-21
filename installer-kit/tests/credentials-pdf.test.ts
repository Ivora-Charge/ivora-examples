import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import {
  PASSWORD_PATTERN,
  afterFirstDisplay,
  firstDisplay,
  generatePassword,
  maskSecret,
} from "@/lib/credentials";
import { pdfText, reportPdf, stickerPdf } from "@/lib/pdf";
import { TEST_SESSION_LABEL, type Charger, type Site } from "@/lib/types";

describe("credentials", () => {
  it("generates strong passwords the API accepts", () => {
    const all = new Set(Array.from({ length: 200 }, generatePassword));
    expect(all.size).toBe(200);
    for (const pw of all) expect(pw).toMatch(PASSWORD_PATTERN);
  });

  it("shows the password once, then only a fixed-width mask", () => {
    const pw = generatePassword();
    expect(firstDisplay(pw).password).toBe(pw);
    const later = afterFirstDisplay(pw);
    expect(later.password).toBeNull();
    expect(JSON.stringify(later)).not.toContain(pw);
    // The mask leaks neither content nor length.
    expect(maskSecret("a")).toBe(maskSecret(pw));
  });
});

const site: Site = {
  id: "s1",
  locationId: "demo-loc-1",
  name: "Sample Depot",
  address: "1 Example Way",
  city: "Springfield",
  state: "",
  postalCode: "",
  country: "USA",
};

const charger: Charger = {
  id: "c1",
  siteId: "s1",
  name: "ik-demo-1",
  stationId: "demo-1",
  connectionUrl: "wss://ocpp.demo.invalid/ocpp16/ik-demo-1",
  username: "ik-demo-1",
  createdAt: "2026-10-19T12:00:00Z",
  demo: true,
  passwordMasked: "••••••••••••",
  passwordSet: true,
  state: "booted",
  lastChangeAt: "2026-10-19T12:00:04Z",
  boot: { vendor: "DemoCharge", model: "DC-22", firmware: "1.0.0" },
  connectors: [{ resourceId: "r1", number: 1, code: "ABCD2345" }],
  test: {
    attempt: 1,
    phase: "done",
    connectorNumber: 1,
    requestedAt: "2026-10-19T12:01:00Z",
    startedAt: "2026-10-19T12:01:01Z",
    finishedAt: "2026-10-19T12:01:31Z",
    energyWh: 92,
    passed: true,
  },
  config: {
    readAt: "2026-10-19T12:02:00Z",
    values: { HeartbeatInterval: "300", MeterValueSampleInterval: "60" },
  },
  tariffCentsPerKwh: 35,
  seq: { credentials: 1, test: 1, config: 1 },
};

describe("PDFs", () => {
  it("renders a one-page sticker per connector", async () => {
    const bytes = await stickerPdf({
      url: "https://charge.example.com/s/ABCD2345",
      code: "ABCD2345",
      siteName: "Sample Depot",
      chargerName: "ik-demo-1",
      connectorNumber: 1,
      demo: false,
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toBe("Charging sticker ABCD2345");
  });

  it("renders a demo sticker and a one-page report", async () => {
    const demo = await stickerPdf({
      url: "http://localhost:3000/s/ABCD2345",
      code: "ABCD2345",
      siteName: "Café ☕ Depot",
      chargerName: "ik-demo-1",
      connectorNumber: 1,
      demo: true,
    });
    expect((await PDFDocument.load(demo)).getPageCount()).toBe(1);
    const report = await PDFDocument.load(
      await reportPdf({
        charger,
        site,
        stickerBase: "https://charge.example.com",
      }),
    );
    expect(report.getPageCount()).toBe(1);
    expect(report.getTitle()).toBe("Commissioning report ik-demo-1");
  });

  it("renders a report before any test or configuration read", async () => {
    const bare = {
      ...charger,
      test: undefined,
      config: undefined,
      boot: undefined,
      connectors: [],
    };
    const doc = await PDFDocument.load(
      await reportPdf({ charger: bare, site, stickerBase: null }),
    );
    expect(doc.getPageCount()).toBe(1);
  });

  it("labels the test session and shows the in-service time", async () => {
    const text = async (c: Charger) => {
      const bytes = await reportPdf({ charger: c, site, stickerBase: null });
      const doc = await PDFDocument.load(bytes);
      const out: string[] = [];
      for (const ref of doc.context.enumerateIndirectObjects()) {
        const [, obj] = ref;
        const contents = (obj as { contents?: Uint8Array }).contents;
        if (!contents) continue;
        try {
          out.push(Buffer.from(inflateSync(contents)).toString("latin1"));
        } catch {
          // Not a compressed stream (fonts, metadata).
        }
      }
      return out.join("\n");
    };
    // The standard fonts write strings as hex.
    const shown = (t: string, v: string) =>
      expect(t).toContain(
        `<${Buffer.from(v).toString("hex").toUpperCase()}> Tj`,
      );
    const before = await text(charger);
    shown(before, TEST_SESSION_LABEL);
    shown(before, "Not yet");
    const after = await text({
      ...charger,
      inServiceAt: "2026-10-19T13:00:00.000Z",
    });
    shown(after, "2026-10-19T13:00:00.000Z");
  });

  it("replaces characters the standard fonts cannot encode", () => {
    expect(pdfText("Café ☕")).toBe("Café ?");
  });
});
