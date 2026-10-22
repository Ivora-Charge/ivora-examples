import { randomUUID } from "node:crypto";
import {
  driverSessions,
  EXAMPLE_SESSION,
  getCheckout,
  loadChargePage,
  type ChargePage,
} from "@/lib/server/checkout";
import { DEMO_CHECKOUT_SIMULATIONS } from "@/lib/server/checkout/demo";
import { cookieDemoCheckout } from "@/lib/server/checkout/demo-cookie";
import { driverCheckoutIds } from "@/lib/server/checkout/driver-cookie";
import { config, isDemo } from "@/lib/server/env";
import { demoSimulateAction } from "./actions";
import { PayForm, StartForm } from "./forms";
import { AutoRefresh } from "./refresh";

export const metadata = { title: "Charge here" };

const SIMULATION_LABELS: Record<
  (typeof DEMO_CHECKOUT_SIMULATIONS)[number],
  string
> = {
  none: "Nothing: the charger is free and Stripe is ready",
  offline: "The charger is offline",
  in_use: "The connector is in use",
  stripe_not_ready: "The operator's Stripe account isn't ready",
};

/** Status in words with a shape, never colour alone. */
function StatusPill({ c }: { c: NonNullable<ChargePage["connector"]> }) {
  const [tone, label] =
    c.blocked === "offline"
      ? ["off", "Offline"]
      : c.blocked === "in_use"
        ? ["busy", "In use"]
        : c.blocked === "out_of_order"
          ? ["warn", c.status ?? "Unavailable"]
          : ["ok", c.status === "Preparing" ? "Plugged in" : "Available"];
  return <span className={`pill ${tone}`}>{label}</span>;
}

const IN_PROGRESS = new Set([
  "awaiting_payment",
  "starting",
  "waiting_for_vehicle",
  "charging",
]);

/**
 * Where a sticker's QR code lands, on your own domain. Public: drivers are not staff.
 * Shows the charger, the connector's status and price (with Ivora's quote of an example
 * session), and "Pay and charge", which hands the driver to Ivora Checkout. After
 * paying, the driver continues on Ivora's driver page (live session and receipt); a
 * driver who comes back here sees their own session.
 */
export default async function Page({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const demo = isDemo();
  const d = getCheckout();
  const page = await loadChargePage(d, code, config.operatorName);
  const sessions =
    page.state === "open"
      ? await driverSessions(d, page.code, await driverCheckoutIds())
      : [];
  const simulate = demo ? (await cookieDemoCheckout().load()).simulate : null;
  const live = sessions.some((s) => s.progress && IN_PROGRESS.has(s.progress));

  if (page.state !== "open")
    return (
      <section className="card" aria-labelledby="charge-heading">
        {demo && (
          <p className="notice" role="note">
            Demo sticker: simulated charger.
          </p>
        )}
        <h1 id="charge-heading">Charge here</h1>
        {page.state === "not_in_service" ? (
          <p>
            This charger is not in service. Please use another one, or contact
            the site operator.
          </p>
        ) : (
          <p>
            Sticker code <code>{page.code}</code> is not known here. Please
            contact the site operator.
          </p>
        )}
      </section>
    );

  return (
    <>
      {live && <AutoRefresh seconds={5} />}
      {demo && (
        <p className="notice" role="note">
          Demo sticker: simulated charger. No card is needed and nothing is
          charged.
        </p>
      )}
      <header className="charge-board">
        <p className="muted">{page.operatorName}</p>
        <h1 id="charge-heading">
          {page.chargerName}, connector {page.connectorNumber}
          {page.connector?.maxPowerKw ? (
            <span className="muted"> up to {page.connector.maxPowerKw} kW</span>
          ) : null}
        </h1>
        {page.connector && <StatusPill c={page.connector} />}
      </header>

      {sessions.length > 0 && (
        <section className="card" aria-labelledby="sessions-heading">
          <h2 id="sessions-heading">Your session</h2>
          <ul className="rows">
            {sessions.map((s) => (
              <li key={s.id}>
                <p>
                  <strong>{s.label}</strong>
                  {s.energyKwh && <> · {s.energyKwh} kWh</>}
                  {s.estimate && <> · {s.estimate} so far</>}
                </p>
                <p className="muted">{s.detail}</p>
                {s.canStart && <StartForm code={page.code} id={s.id} />}
              </li>
            ))}
          </ul>
          <p className="muted">
            Your live session and receipt are on the payment page you were sent
            to after paying (run by Ivora, our payment partner). Keep that page
            open to follow your session.
          </p>
        </section>
      )}

      {page.tariffName && (
        <section className="card" aria-labelledby="price-heading">
          <h2 id="price-heading">Price</h2>
          {page.priceText && (
            <p>
              <strong>Price:</strong> {page.priceText}
            </p>
          )}
          {page.example && (
            <>
              <table className="price-table">
                <caption>
                  Example: {EXAMPLE_SESSION.energyKwh} kWh over an hour,
                  starting now
                </caption>
                <tbody>
                  {page.example.lines.map((l, i) => (
                    <tr key={i}>
                      <td>{l.label}</td>
                      <td className="num">{l.amount}</td>
                    </tr>
                  ))}
                  <tr className="total">
                    <td>Example total</td>
                    <td className="num" data-testid="example-total">
                      {page.example.total}
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="muted">
                Priced by the payment service with this charger&apos;s tariff.
                You pay for what you actually use.
              </p>
            </>
          )}
        </section>
      )}

      <section className="card stack" aria-labelledby="pay-heading">
        <h2 id="pay-heading">Pay and charge</h2>
        {page.closed && (
          <p
            className={page.closed.code === "private" ? "notice" : "error"}
            role={page.closed.code === "private" ? "note" : "alert"}
          >
            {page.closed.message}
          </p>
        )}
        {page.readError && (
          <p className="notice" role="note">
            {page.readError}
          </p>
        )}
        {page.hold && (
          <>
            <p>
              Your card is authorized for a <strong>{page.hold}</strong> hold.
              You pay for your session at the price above, and the rest of the
              hold is released.
            </p>
            <PayForm
              code={page.code}
              requestId={randomUUID()}
              hold={page.hold}
              closed={Boolean(page.closed)}
              demo={demo}
            />
            <p className="muted">
              {demo
                ? "Demo: a simulated checkout stands in for Stripe. No card is needed and nothing is charged."
                : `You pay ${page.operatorName} by card, Apple Pay or Google Pay through Stripe, on a secure page run by Ivora, our payment partner. After paying you stay on Ivora's page, which shows your live session and your receipt.`}
            </p>
          </>
        )}
      </section>

      {demo && simulate && (
        <section className="card demo-sim" aria-labelledby="sim-heading">
          <h2 id="sim-heading">Demo: simulate</h2>
          <form action={demoSimulateAction} className="form inline">
            <input type="hidden" name="code" value={page.code} />
            <div className="field">
              <label htmlFor="simulate">What this sticker page sees</label>
              <select id="simulate" name="simulate" defaultValue={simulate}>
                {DEMO_CHECKOUT_SIMULATIONS.map((s) => (
                  <option key={s} value={s}>
                    {SIMULATION_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="button secondary">
              Simulate
            </button>
          </form>
        </section>
      )}
    </>
  );
}
