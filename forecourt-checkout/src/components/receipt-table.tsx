import { formatCents } from "@/lib/money";
import type { Receipt } from "@/lib/view";

/** Final breakdown from Ivora's bill, then what happened on the card. */
export function ReceiptTable({ receipt }: { receipt: Receipt }) {
  const s = receipt.settlement;
  const money = (cents: number) => formatCents(cents, receipt.currency);
  return (
    <table>
      <tbody>
        {receipt.rows.map((r, i) => (
          <tr key={i}>
            <td>
              {r.label}
              <div className="muted">{r.detail}</div>
            </td>
            <td className="num">{money(r.amountCents)}</td>
          </tr>
        ))}
        <tr>
          <td>Session total</td>
          <td className="num">{money(s.billTotalCents)}</td>
        </tr>
        {s.graceCreditCents > 0 ? (
          <tr>
            <td>
              Idle grace period
              <div className="muted">
                first {receipt.graceMinutes} idle minutes are free
              </div>
            </td>
            <td className="num">−{money(s.graceCreditCents)}</td>
          </tr>
        ) : null}
        <tr className="total">
          <td>Charged to your card</td>
          <td className="num">{money(s.chargedCents)}</td>
        </tr>
        <tr>
          <td className="muted">Hold released</td>
          <td className="num muted">{money(s.releasedCents)}</td>
        </tr>
      </tbody>
      <caption
        className="muted"
        style={{
          captionSide: "bottom",
          textAlign: "left",
          paddingTop: "0.5rem",
        }}
      >
        {s.reason === "below_minimum"
          ? `Amounts under ${money(50)} are not charged; your hold was released in full.`
          : s.reason === "capped_at_hold"
            ? `The session cost more than your hold. Only the hold amount was charged; ${money(s.uncollectedCents)} was not charged.`
            : s.reason === "zero"
              ? "Nothing to pay; your hold was released in full."
              : "Released holds usually disappear from your statement within a few days, depending on your bank."}
      </caption>
    </table>
  );
}
