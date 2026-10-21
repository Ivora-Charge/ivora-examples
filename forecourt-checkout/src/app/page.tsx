import Link from "next/link";
import { DEMO_CHARGERS, DEMO_SITE_NAME } from "@/lib/demo";
import { settings } from "@/lib/server/services";

export default function Home() {
  const s = settings();
  return (
    <main>
      <h1>Forecourt checkout</h1>
      <p className="muted">
        Drivers scan the QR code on a DC fast charger, pay with a card, Apple
        Pay or Google Pay, watch the session live and get a receipt. No app or
        account. Or they pay in the store, like fuel: the cashier authorises the
        charger, takes cash or card on the store&apos;s POS, and prints a
        receipt.
      </p>
      {s.demo ? (
        <div className="card stack">
          <h2>{DEMO_SITE_NAME}</h2>
          <p className="muted">
            Open a charger as if you had scanned its QR code:
          </p>
          <ul>
            {DEMO_CHARGERS.flatMap((c) =>
              c.connectors.map((k) => (
                <li key={`${c.code}-${k.number}`}>
                  <Link href={`/c/${c.code}/${k.number}`}>
                    {c.name} · {k.label} {k.maxPowerW / 1000} kW
                  </Link>{" "}
                  <span className="muted">({k.status})</span>
                </li>
              )),
            )}
          </ul>
        </div>
      ) : (
        <div className="card">
          <p>Scan the QR code on a charger to start.</p>
        </div>
      )}
      <p className="muted">
        Site staff: <Link href="/operator">operator pages</Link>
        {s.payInStore ? (
          <>
            {" "}
            · <Link href="/cashier">cashier console</Link>
          </>
        ) : null}
        {s.demo ? " (demo password: demo)" : null}
      </p>
    </main>
  );
}
