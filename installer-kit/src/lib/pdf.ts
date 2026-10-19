import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { qrPng } from "./qr";
import type { Charger, Site } from "./types";

const A4: [number, number] = [595, 842];

/** One A4 page with a large QR for a single connector. Written from scratch for this template. */
export async function stickerPdf(opts: {
  url: string;
  siteName: string;
  connectorLabel: string;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const img = await doc.embedPng(await qrPng(opts.url, 800));
  const size = 360;
  const x = (A4[0] - size) / 2;
  page.drawText("Scan to charge", { x: 150, y: 740, size: 36, font: bold });
  page.drawImage(img, { x, y: 300, width: size, height: size });
  page.drawText(opts.connectorLabel, { x: x, y: 260, size: 22, font: bold });
  page.drawText(opts.siteName, { x: x, y: 232, size: 14, font });
  page.drawText(opts.url, {
    x: x,
    y: 210,
    size: 9,
    font,
    color: rgb(0.3, 0.3, 0.3),
  });
  return doc.save();
}

/** One-page commissioning report. */
export async function reportPdf(opts: {
  charger: Charger;
  site: Site;
  date?: Date;
}): Promise<Uint8Array> {
  const { charger, site } = opts;
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let y = 780;
  const line = (label: string, value: string) => {
    page.drawText(label, { x: 50, y, size: 11, font: bold });
    page.drawText(value, { x: 200, y, size: 11, font });
    y -= 22;
  };
  page.drawText("Commissioning report", { x: 50, y, size: 24, font: bold });
  y -= 40;
  if (charger.demo) {
    page.drawText("DEMO DATA - simulated charger", {
      x: 50,
      y,
      size: 12,
      font: bold,
      color: rgb(0.8, 0.2, 0.1),
    });
    y -= 28;
  }
  line("Date", (opts.date ?? new Date()).toISOString().slice(0, 10));
  line("Site", site.name);
  line("Address", site.address);
  line("Charger", charger.name);
  line("Station ID", charger.id);
  line("Vendor", charger.boot?.vendor ?? "-");
  line("Model", charger.boot?.model ?? "-");
  line("Firmware", charger.boot?.firmware ?? "-");
  line("Connectors", String(charger.boot?.connectors.length ?? 0));
  y -= 10;
  const t = charger.test;
  line("Test result", t ? (t.passed ? "PASSED" : "FAILED") : "Not run");
  if (t) {
    line("Energy delivered", `${t.energyKwh.toFixed(2)} kWh`);
    line("Heartbeat interval", `${t.config.HeartbeatInterval} s`);
    line("Meter interval", `${t.config.MeterValueSampleInterval} s`);
  }
  return doc.save();
}
