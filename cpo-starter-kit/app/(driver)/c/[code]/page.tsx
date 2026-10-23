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
import { driverRequestIds } from "@/lib/server/checkout/driver-cookie";
import { config, isDemo } from "@/lib/server/env";
import { demoSimulateAction } from "./actions";
import { FreeForm, PayForm, StartForm, StopForm } from "./forms";
import { AutoRefresh } from "./refresh";
import { Loading } from "@/app/loading-skeleton";

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

/**
 * Where a sticker's QR code lands, on your own domain. Public: drivers are not staff.
 * Shows the charger, the connector's status and price (with Ivora's quote of an example
 * session), and "Pay and charge", which hands the driver to Ivora Checkout, or "Start
 * free session" on a free tariff. After paying, Stripe returns the driver to Ivora's
 * page, which can't show the kit's sessions yet; a driver who comes back here sees
 * their own session, can start or stop it, and sees what was charged.
 */
async function Content({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const demo = isDemo();
  const d = getCheckout();
  const ids = await driverRequestIds();
  // Sessions first: reading them settles them, which may free the connector.
  const sessions = await driverSessions(d, code, ids);
  const page = await loadChargePage(d, code, config.operatorName, ids);
  const simulate = demo ? (await cookieDemoCheckout().load()).simulate : null;
  const live = sessions.some((s) => s.live);

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
        <h1 id="charge-heading">
          {page.chargerName}, connector {page.connectorNumber}
          {page.connector?.maxPowerKw ? (
            <span className="muted"> up to {page.connector.maxPowerKw} kW</span>
          ) : null}
        </h1>
        {page.connector && <StatusPill c={page.connector} />}
      </header>

      {page.state === "open" && sessions.length > 0 && (
        <section className="card" aria-labelledby="sessions-heading">
          <h2 id="sessions-heading">Your session</h2>
          <ul className="rows">
            {sessions.map((s) => (
              <li key={s.requestId}>
                <p>
                  <strong>{s.label}</strong>
                  {s.energyKwh && <> · {s.energyKwh} kWh</>}
                  {s.estimate && <> · {s.estimate} so far</>}
                </p>
                <p className="muted">{s.detail}</p>
                {s.note && (
                  <p className="notice" role="note">
                    {s.note}
                  </p>
                )}
                {s.receipt && (
                  <dl className="facts" aria-label="Receipt">
                    <div>
                      <dt>Charged</dt>
                      <dd data-testid="receipt-charged">{s.receipt.charged}</dd>
                    </div>
                    <div>
                      <dt>Hold released</dt>
                      <dd>
                        {s.receipt.released} of {s.receipt.hold}
                      </dd>
                    </div>
                  </dl>
                )}
                {s.receipt && demo && (
                  <p className="muted">
                    Demo receipt: no card was charged and no money moved.
                  </p>
                )}
                {s.canStart && (
                  <StartForm code={page.code} requestId={s.requestId} />
                )}
                {s.canStop && (
                  <StopForm code={page.code} requestId={s.requestId} />
                )}
              </li>
            ))}
          </ul>
          {sessions.some((s) => s.kind === "paid") && (
            <p className="muted">
              Follow your session here: scan the sticker again, or keep this
              page open. The payment page you return to after paying (run by
              Ivora, our payment partner) can&apos;t show this session yet.
            </p>
          )}
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
        <h2 id="pay-heading">
          {page.kind === "free" ? "Start a free session" : "Pay and charge"}
        </h2>
        {page.closed && (
          <p
            className={
              page.closed.code === "private" || page.mine ? "notice" : "error"
            }
            role={
              page.closed.code === "private" || page.mine ? "note" : "alert"
            }
          >
            {page.closed.message}
          </p>
        )}
        {page.readError && (
          <p className="notice" role="note">
            {page.readError}
          </p>
        )}
        {page.kind === "free" && (
          <>
            <p>Charging here is free: no payment or card is needed.</p>
            <FreeForm
              code={page.code}
              requestId={randomUUID()}
              closed={Boolean(page.closed)}
            />
          </>
        )}
        {page.kind === "paid" && (
          <>
            <p>
              {page.hold ? (
                <>
                  Your card is authorized for a <strong>{page.hold}</strong>{" "}
                  hold.
                </>
              ) : (
                "Your card is authorized for a hold before charging."
              )}{" "}
              You pay for your session at the price above, and the rest of the
              hold is released. Charging stops by itself before the hold is used
              up.
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
                : `You pay ${page.operatorName} by card, Apple Pay or Google Pay through Stripe, on a secure page run by Ivora, our payment partner. Then come back to this page to follow your session.`}
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

/** The page behind its loading skeleton. */
export default function Page(props: Parameters<typeof Content>[0]) {
  return (
    <Loading shape="driver">
      <Content {...props} />
    </Loading>
  );
}
