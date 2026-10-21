import { formatCents } from "@/lib/money";
import type { SaleView } from "@/lib/store";
import { formatLocalDateTime } from "@/lib/time";
import { formatDuration, whToKwhText } from "@/lib/units";

/** An 80 mm thermal-friendly store receipt: energy, time, rates, idle fee, total and how it was paid. */
export function StoreReceipt({
  view,
  siteName,
  timeZone,
}: {
  view: SaleView;
  siteName: string;
  timeZone: string;
}) {
  const bill = view.bill;
  const a = view.amounts;
  const money = (cents: number) => formatCents(cents, view.currency);
  const seconds =
    view.startedAt && view.endedAt
      ? (Date.parse(view.endedAt) - Date.parse(view.startedAt)) / 1000
      : 0;
  const method = (m: string | null) =>
    m === "card" ? "card" : m === "cash" ? "cash" : "prepaid";
  return (
    <div className="thermal" data-testid="store-receipt">
      <p className="center">
        <strong>{siteName}</strong>
        <br />
        EV charging receipt
        {view.demo ? (
          <>
            <br />
            DEMO: nothing was charged
          </>
        ) : null}
      </p>
      <table>
        <tbody>
          <tr>
            <td>Charger</td>
            <td className="num">{view.charger.label}</td>
          </tr>
          <tr>
            <td>Started</td>
            <td className="num">
              {formatLocalDateTime(view.startedAt, timeZone)}
            </td>
          </tr>
          <tr>
            <td>Ended</td>
            <td className="num">
              {formatLocalDateTime(view.endedAt, timeZone)}
            </td>
          </tr>
          <tr>
            <td>Time</td>
            <td className="num">{formatDuration(seconds * view.speed)}</td>
          </tr>
          <tr>
            <td>Energy</td>
            <td className="num">{whToKwhText(view.energyWh)} kWh</td>
          </tr>
        </tbody>
      </table>
      <hr />
      <table>
        <tbody>
          {bill?.rows.map((r, i) => (
            <tr key={i}>
              <td>
                {r.label}
                <div className="small">{r.detail}</div>
              </td>
              <td className="num">{money(r.amountCents)}</td>
            </tr>
          ))}
          {bill && bill.graceCreditCents > 0 ? (
            <tr>
              <td>
                Idle grace
                <div className="small">
                  first {bill.graceMinutes} idle minutes free
                </div>
              </td>
              <td className="num">−{money(bill.graceCreditCents)}</td>
            </tr>
          ) : null}
          <tr className="total">
            <td>Total</td>
            <td className="num">{money(a?.dueCents ?? 0)}</td>
          </tr>
          {view.terms.mode === "prepay" && a ? (
            <>
              <tr>
                <td>Prepaid</td>
                <td className="num">{money(a.prepaidCents)}</td>
              </tr>
              {a.changeCents > 0 ? (
                <tr>
                  <td>Change{a.changeGiven ? " given" : " due"}</td>
                  <td className="num">{money(a.changeCents)}</td>
                </tr>
              ) : null}
              {a.overrunCents > 0 ? (
                <tr>
                  <td>Used more than prepaid</td>
                  <td className="num">{money(a.overrunCents)}</td>
                </tr>
              ) : null}
            </>
          ) : null}
          {a?.payments
            .filter((p) => p.step !== "prepaid")
            .map((p, i) => (
              <tr key={i}>
                <td>
                  Paid in store ({method(p.method)})
                  {p.posReference ? (
                    <div className="small">POS ref {p.posReference}</div>
                  ) : null}
                </td>
                <td className="num">{money(p.amountCents)}</td>
              </tr>
            ))}
          {a && a.outstandingCents > 0 ? (
            <tr className="total">
              <td>Still due</td>
              <td className="num">{money(a.outstandingCents)}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <hr />
      <p className="center small">
        Payment: paid in store
        <br />
        Sale {view.sale}
      </p>
    </div>
  );
}
