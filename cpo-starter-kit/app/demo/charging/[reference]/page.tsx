import { notFound } from "next/navigation";
import { formatMinor } from "@/lib/money";
import { getCheckout, PROGRESS } from "@/lib/server/checkout";
import { isDemo } from "@/lib/server/env";
import { getIvora } from "@/lib/server/ivora";
import { findDemoBill } from "@/lib/server/ivora/demo";
import { cookieDemoFleet } from "@/lib/server/ivora/demo-cookie";
import { AutoRefresh } from "../../../c/[code]/refresh";
import { demoStopAction } from "../../actions";

export const metadata = { title: "Demo session" };

const when = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "medium",
        timeZone: "UTC",
      }).format(Date.parse(iso)) + " UTC"
    : "-";

/**
 * Demo mode only: stands in for Ivora's driver page, where a real driver lands after
 * paying (return_surface driver): the live session, then the receipt. Here it reads
 * the demo bill, which starts the simulated charger the way Ivora's page does.
 */
export default async function Page({
  params,
}: {
  params: Promise<{ reference: string }>;
}) {
  if (!isDemo()) notFound();
  const { reference } = await params;
  const billId = await findDemoBill(cookieDemoFleet(), reference);
  if (!billId) notFound();
  const bill = await getIvora().getBill(billId);
  const rec = await getCheckout().store.get("demo", reference);
  const progress = bill.progress ?? "awaiting_payment";
  const step = PROGRESS[progress];
  const u = bill.usage;
  const money = (m: number) => formatMinor(m, bill.currency);
  const ended = progress === "ended";
  return (
    <>
      {!ended && <AutoRefresh seconds={2} />}
      <p className="notice" role="note">
        Demo: this page stands in for Ivora&apos;s driver page, where drivers
        follow their session and get their receipt after paying. Nothing is
        charged.
      </p>
      <section className="card stack" aria-labelledby="session-heading">
        <h1 id="session-heading">{step.label}</h1>
        <p>
          {ended
            ? "Your session has ended. Your receipt is below."
            : step.detail}
        </p>
        {u && (
          <dl className="facts">
            <div>
              <dt>Energy</dt>
              <dd>{((u.energy_wh ?? 0) / 1000).toFixed(2)} kWh</dd>
            </div>
            {typeof u.estimated_minor === "number" && (
              <div>
                <dt>{ended ? "Total" : "Cost so far"}</dt>
                <dd data-testid="session-cost">{money(u.estimated_minor)}</dd>
              </div>
            )}
          </dl>
        )}
        {progress === "charging" && (
          <form action={demoStopAction}>
            <input type="hidden" name="bill" value={bill.id} />
            <input type="hidden" name="reference" value={reference} />
            <button type="submit" className="button">
              Stop charging
            </button>
          </form>
        )}
      </section>
      {ended && u && (
        <section className="card" aria-labelledby="receipt-heading">
          <h2 id="receipt-heading">Receipt (demo)</h2>
          <dl className="facts">
            <div>
              <dt>Started</dt>
              <dd>{when(u.started_at)}</dd>
            </div>
            <div>
              <dt>Ended</dt>
              <dd>{when(u.ended_at)}</dd>
            </div>
            <div>
              <dt>Energy</dt>
              <dd>{((u.energy_wh ?? 0) / 1000).toFixed(2)} kWh</dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd data-testid="receipt-total">
                {money(u.estimated_minor ?? 0)}
              </dd>
            </div>
            <div>
              <dt>Card hold released</dt>
              <dd>
                {money(Math.max(0, bill.hold_minor - (u.estimated_minor ?? 0)))}{" "}
                of {money(bill.hold_minor)}
              </dd>
            </div>
          </dl>
          <p className="muted">
            Demo receipt: no card was charged and no money moved.
          </p>
        </section>
      )}
      {rec && (
        <p>
          <a href={`/c/${rec.stickerCode}`}>Back to the charger</a>
        </p>
      )}
    </>
  );
}
