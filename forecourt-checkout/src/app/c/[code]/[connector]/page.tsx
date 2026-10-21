import Link from "next/link";
import { ErrorBox } from "@/components/error-box";
import { PayButton } from "@/components/pay-button";
import { formatCents } from "@/lib/money";
import { chargerFor } from "@/lib/server/driver";
import { errorInfo } from "@/lib/server/http";
import { settings } from "@/lib/server/services";
import type { ChargerPage } from "@/lib/server/sessions";

export const dynamic = "force-dynamic";

function statusPill(status: string, available: boolean) {
  const tone = available
    ? "ok"
    : status === "Faulted" || status === "Offline"
      ? "bad"
      : "warn";
  return (
    <span className={`pill ${tone}`}>{available ? "Available" : status}</span>
  );
}

export default async function Charger({
  params,
}: {
  params: Promise<{ code: string; connector: string }>;
}) {
  const { code, connector } = await params;
  const s = settings();
  let page: ChargerPage;
  try {
    if (!/^\d{1,2}$/.test(connector)) throw new Error("bad connector");
    page = await chargerFor(decodeURIComponent(code), Number(connector), s);
  } catch (error) {
    const info =
      error instanceof Error && error.message === "bad connector"
        ? { error: "charger_not_found", message: "This QR code is not valid." }
        : errorInfo(error).body;
    return (
      <main>
        <h1>Charger unavailable</h1>
        <ErrorBox
          info={info}
          title="We can't take payments on this charger right now"
        />
      </main>
    );
  }
  const c = page.connector;
  return (
    <main>
      <header className="board">
        <p className="muted" style={{ marginBottom: 0 }}>
          {page.name}
        </p>
        <h1>
          {c.label}{" "}
          {c.maxPowerW ? (
            <span className="muted">
              up to {Math.round(c.maxPowerW / 1000)} kW
            </span>
          ) : null}
        </h1>
        {statusPill(c.status, c.available)}
      </header>

      <section className="card">
        <h2>Prices</h2>
        <table>
          <tbody>
            {page.prices.map((p) => (
              <tr key={p.label}>
                <td>{p.label}</td>
                <td className="num">{p.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {page.conditional ? (
          <p className="muted">
            Some prices depend on the time of day or charging power. The
            estimate below uses them.
          </p>
        ) : null}
        {page.idlePerMinuteCents > 0 ? (
          <p className="muted">
            Idle fee: after charging ends you have {page.graceMinutes} minutes
            to move your car. After that the idle fee applies until you unplug.
          </p>
        ) : null}
      </section>

      <section className="card">
        <h2>
          Typical session: {page.estimate.kwh} kWh in {page.estimate.minutes}{" "}
          min
        </h2>
        <table>
          <tbody>
            {page.estimate.rows.map((r, i) => (
              <tr key={i}>
                <td>
                  {r.label}
                  <div className="muted">{r.detail}</div>
                </td>
                <td className="num">
                  {formatCents(r.amountCents, page.currency)}
                </td>
              </tr>
            ))}
            <tr className="total">
              <td>Estimated total</td>
              <td className="num">
                {formatCents(page.estimate.totalCents, page.currency)}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="muted">
          Estimate from the site&apos;s tariff. You pay for what you actually
          use.
        </p>
      </section>

      <section className="card stack" aria-label="Pay here by card">
        {page.payInStore ? (
          <h2 style={{ margin: 0 }}>Pay here by card</h2>
        ) : null}
        <p style={{ margin: 0 }}>
          We place a{" "}
          <strong>{formatCents(page.holdCents, page.currency)}</strong> hold on
          your card. When you finish, you pay only for your session and the rest
          is released. Charging stops automatically before it reaches the hold.
        </p>
        <PayButton
          code={page.code}
          connector={c.number}
          disabled={!c.available}
          demo={page.demo}
          holdLabel={formatCents(page.holdCents, page.currency)}
        />
        <p className="muted" style={{ margin: 0 }}>
          {page.demo
            ? "Demo: no card is needed and nothing is charged."
            : "Card, Apple Pay or Google Pay, through Stripe."}
        </p>
      </section>

      {page.payInStore ? (
        <section className="card stack" aria-label="Pay at the counter">
          <h2 style={{ margin: 0 }}>Pay at the counter</h2>
          <p style={{ margin: 0 }}>
            Pay cash or card in the store, like fuel. Tell the cashier{" "}
            <strong>{page.label}</strong>.
          </p>
          <Link
            className="button secondary block"
            href={`/c/${encodeURIComponent(page.code)}/${c.number}/counter`}
          >
            Pay at the counter: tell the cashier {page.label}
          </Link>
        </section>
      ) : null}
    </main>
  );
}
