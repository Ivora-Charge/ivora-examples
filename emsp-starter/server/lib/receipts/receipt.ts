import "server-only";
import { brand } from "@/brand";
import type { Cdr } from "@/lib/ocpi/session-objects";
import { formatMinor } from "@/lib/payments/money";
import type { Payment } from "@/lib/payments/store";
import type { Email } from "./mailer";

/**
 * The email receipt of a settled payment, from its CDR: where and when, the energy,
 * the CPO's total, what was charged, and why the session stopped when we stopped it.
 * Never card data: Stripe's own receipt, if you switch it on, names the card.
 */
export function receiptEmail(
  to: string,
  payment: Payment,
  cdr: Cdr,
  options: { demo?: boolean } = {},
): Email {
  const where = [
    cdr.cdr_location.name,
    cdr.cdr_location.address,
    cdr.cdr_location.city,
  ]
    .filter(Boolean)
    .join(", ");
  const when = `${new Date(cdr.start_date_time).toUTCString()} to ${new Date(cdr.end_date_time).toUTCString()}`;
  const total = formatMinor(payment.cdrAmount ?? 0, cdr.currency);
  const charged = formatMinor(payment.capturedAmount, payment.currency);
  const lines: [string, string][] = [
    ["Location", where],
    ["Charger", cdr.cdr_location.evse_id],
    ["Time (UTC)", when],
    ["Energy", `${cdr.total_energy.toFixed(3).replace(/\.?0+$/, "")} kWh`],
    [
      "Session cost",
      cdr.total_cost.incl_vat === undefined
        ? `${total} (excl. VAT)`
        : `${total} incl. VAT`,
    ],
    ["Charged to your card", charged],
  ];
  if (payment.stopReason) lines.push(["Stopped", payment.stopReason]);
  const notes: string[] = [];
  if (payment.status === "released")
    notes.push("Nothing was charged: the hold on your card has been released.");
  if (payment.shortfallAmount)
    notes.push(
      `The session cost more than the amount held on your card. Only ${charged} was charged; the rest is not charged automatically.`,
    );
  if (options.demo)
    notes.unshift(
      "Demo mode: this receipt was not sent and nothing was charged.",
    );
  const reference = `Receipt ${payment.id} · CDR ${cdr.id}`;

  const text = [
    `${brand.name}: charging receipt`,
    "",
    ...lines.map(([k, v]) => `${k}: ${v}`),
    ...(notes.length ? ["", ...notes] : []),
    "",
    reference,
  ].join("\n");

  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><html><body style="font-family:${esc(
    "system-ui, sans-serif",
  )};color:${esc(brand.color.text)}">
<h1 style="font-size:20px">${esc(brand.name)}: charging receipt</h1>
<table cellpadding="4">${lines
    .map(
      ([k, v]) => `<tr><th align="left">${esc(k)}</th><td>${esc(v)}</td></tr>`,
    )
    .join("")}</table>
${notes.map((n) => `<p>${esc(n)}</p>`).join("\n")}
<p style="color:${esc(brand.color.muted)};font-size:12px">${esc(reference)}</p>
</body></html>`;

  return {
    to,
    subject:
      `Your charging receipt: ${total}${cdr.cdr_location.name ? ` at ${cdr.cdr_location.name}` : ""}`.slice(
        0,
        200,
      ),
    text,
    html,
    idempotencyKey: `receipt:${payment.id}`,
  };
}
