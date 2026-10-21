// The emailed store receipt: the same lines as the printed one, as plain text
// and simple HTML. Pure, so the demo can show exactly what would be sent.

import { formatCents } from "./money";
import type { SaleView } from "./store";
import { formatLocalDateTime } from "./time";
import { whToKwhText } from "./units";

export type ReceiptEmail = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

const EMAIL =
  /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

/** A plausible single address, as typed by the cashier. */
export function isEmailAddress(value: string) {
  return value.length <= 254 && EMAIL.test(value);
}

const escape = (v: string) =>
  v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export function receiptLines(view: SaleView, timeZone: string) {
  const money = (c: number) => formatCents(c, view.currency);
  const a = view.amounts;
  const bill = view.bill;
  const lines: [string, string][] = [
    ["Charger", view.charger.label],
    ["Started", formatLocalDateTime(view.startedAt, timeZone)],
    ["Ended", formatLocalDateTime(view.endedAt, timeZone)],
    ["Energy", `${whToKwhText(view.energyWh)} kWh`],
  ];
  for (const r of bill?.rows ?? []) lines.push([r.label, money(r.amountCents)]);
  if (bill && bill.graceCreditCents > 0)
    lines.push(["Idle grace", `-${money(bill.graceCreditCents)}`]);
  if (a) {
    lines.push(["Total", money(a.dueCents)]);
    if (view.terms.mode === "prepay") {
      lines.push(["Prepaid", money(a.prepaidCents)]);
      if (a.changeCents > 0)
        lines.push([
          a.changeGiven ? "Change given" : "Change due",
          money(a.changeCents),
        ]);
    }
    for (const p of a.payments.filter((p) => p.step !== "prepaid"))
      lines.push([
        `Paid in store (${p.method})${p.posReference ? `, POS ref ${p.posReference}` : ""}`,
        money(p.amountCents),
      ]);
    if (a.outstandingCents > 0)
      lines.push(["Still due", money(a.outstandingCents)]);
  }
  return lines;
}

export function receiptEmail(
  view: SaleView,
  to: string,
  site: { siteName: string; timeZone: string },
): ReceiptEmail {
  const lines = receiptLines(view, site.timeZone);
  const subject = `${site.siteName}: EV charging receipt, ${view.charger.label}`;
  const footer = `Payment: paid in store. Sale ${view.sale}.`;
  const demo = view.demo ? "DEMO: nothing was charged.\n\n" : "";
  const text = `${site.siteName}\nEV charging receipt\n\n${demo}${lines
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n\n${footer}\n`;
  const rows = lines
    .map(
      ([k, v]) =>
        `<tr><td style="padding:2px 12px 2px 0">${escape(k)}</td><td style="text-align:right">${escape(v)}</td></tr>`,
    )
    .join("");
  const html = `<div style="font-family:sans-serif;max-width:420px"><p><strong>${escape(site.siteName)}</strong><br>EV charging receipt</p>${view.demo ? "<p>DEMO: nothing was charged.</p>" : ""}<table>${rows}</table><p style="color:#555">${escape(footer)}</p></div>`;
  return { to, subject, text, html };
}
