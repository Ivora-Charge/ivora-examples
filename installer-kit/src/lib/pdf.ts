import {
  PDFDocument,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
} from "pdf-lib";
import { qrPng } from "./qr";
import { formatCents } from "./tariff";
import { TEST_SESSION_LABEL, type Charger, type Site } from "./types";
import { formatKwh } from "./units";

// Written from scratch for this template.
const A6: [number, number] = [298, 420];
const A4: [number, number] = [595, 842];
const GREY = rgb(0.35, 0.35, 0.35);
const RED = rgb(0.8, 0.15, 0.1);

/** Standard PDF fonts cover Latin-1 only; replace anything else. */
export function pdfText(value: string): string {
  return value.replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}

function centered(
  page: ReturnType<PDFDocument["addPage"]>,
  text: string,
  y: number,
  size: number,
  font: PDFFont,
  color = rgb(0, 0, 0),
) {
  const t = pdfText(text);
  const width = font.widthOfTextAtSize(t, size);
  page.drawText(t, {
    x: (page.getWidth() - width) / 2,
    y,
    size,
    font,
    color,
  });
}

/** One A6 sticker page with a large QR for a single connector. */
export async function stickerPdf(opts: {
  url: string;
  code: string;
  siteName: string;
  chargerName: string;
  connectorNumber: number;
  demo: boolean;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Charging sticker ${opts.code}`);
  const page = doc.addPage(A6);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const img = await doc.embedPng(await qrPng(opts.url, 720));
  const size = 210;
  centered(page, "Scan to charge", 372, 24, bold);
  page.drawImage(img, {
    x: (A6[0] - size) / 2,
    y: 140,
    width: size,
    height: size,
  });
  centered(page, `Connector ${opts.connectorNumber}`, 112, 16, bold);
  centered(page, `${opts.siteName} - ${opts.chargerName}`, 92, 10, font);
  centered(page, `Code ${opts.code}`, 74, 11, bold);
  centered(page, opts.url, 56, 7, font, GREY);
  if (opts.demo) {
    centered(page, "DEMO - NOT FOR PRINTING", 24, 12, bold, RED);
    page.drawText("DEMO", {
      x: 60,
      y: 150,
      size: 96,
      font: bold,
      color: RED,
      opacity: 0.18,
      rotate: degrees(35),
    });
  }
  return doc.save();
}

/** One-page commissioning report. */
export async function reportPdf(opts: {
  charger: Charger;
  site: Site;
  stickerBase: string | null;
  date?: Date;
}): Promise<Uint8Array> {
  const { charger: c, site } = opts;
  const doc = await PDFDocument.create();
  doc.setTitle(`Commissioning report ${c.name}`);
  const page = doc.addPage(A4);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let y = 780;
  const heading = (text: string) => {
    y -= 10;
    page.drawText(text, { x: 50, y, size: 13, font: bold });
    y -= 22;
  };
  const line = (label: string, value: string) => {
    page.drawText(pdfText(label), { x: 50, y, size: 10, font: bold });
    page.drawText(pdfText(value), { x: 200, y, size: 10, font });
    y -= 17;
  };
  page.drawText("Commissioning report", { x: 50, y, size: 24, font: bold });
  y -= 30;
  if (c.demo) {
    page.drawText("DEMO DATA - simulated charger, not a real installation", {
      x: 50,
      y,
      size: 12,
      font: bold,
      color: RED,
    });
    y -= 24;
  }
  line("Date", (opts.date ?? new Date()).toISOString().slice(0, 10));

  heading("Site");
  line("Name", site.name);
  line(
    "Address",
    [site.address, site.city, site.state, site.postalCode]
      .filter(Boolean)
      .join(", "),
  );

  heading("Charger");
  line("Connection name", c.name);
  line("Station ID", c.stationId);
  line("Connection URL", c.connectionUrl);
  line("Vendor", c.boot?.vendor ?? "-");
  line("Model", c.boot?.model ?? "-");
  line("Firmware", c.boot?.firmware ?? "-");
  line("Status", c.state);
  line("In service", c.inServiceAt ?? "Not yet");
  line("Password", c.passwordSet ? "Set (not shown)" : "Not confirmed");

  heading("Connectors and stickers");
  if (!c.connectors.length) line("Connectors", "None reported yet");
  for (const k of c.connectors)
    line(
      `Connector ${k.number}`,
      k.code
        ? `Sticker code ${k.code}${opts.stickerBase ? ` (${opts.stickerBase}/s/${k.code})` : ""}`
        : "-",
    );

  heading(TEST_SESSION_LABEL);
  const t = c.test;
  line(
    "Result",
    !t
      ? "Not run"
      : t.phase === "done"
        ? "PASSED"
        : t.phase === "failed"
          ? `FAILED (${t.errorCode ?? "unknown"})`
          : `In progress (${t.phase})`,
  );
  if (t) {
    line("Energy delivered", `${formatKwh(t.energyWh)} (test)`);
    line("Started", t.startedAt ?? "-");
    line("Finished", t.finishedAt ?? "-");
  }

  heading("Configuration read back");
  line("Heartbeat interval", seconds(c.config?.values.HeartbeatInterval));
  line("Meter interval", seconds(c.config?.values.MeterValueSampleInterval));
  if (c.config) line("Read at", c.config.readAt);

  heading("Price");
  line(
    "Tariff",
    c.tariffCentsPerKwh === undefined
      ? "Not set"
      : `${formatCents(c.tariffCentsPerKwh)} per kWh`,
  );

  y -= 20;
  page.drawText("Installer signature: ______________________", {
    x: 50,
    y,
    size: 10,
    font,
    color: GREY,
  });
  return doc.save();
}

function seconds(value: string | null | undefined) {
  return value ? `${value} s` : "Not read";
}
