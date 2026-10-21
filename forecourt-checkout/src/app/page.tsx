import Link from "next/link";
import { brand } from "../../brand/brand";
import { DEMO_CHARGERS, DEMO_SITE_NAME } from "@/lib/demo";
import { settings } from "@/lib/server/services";

const STEPS = [
  ["1", "Scan", "Scan the QR code on the charger. No app, no account."],
  [
    "2",
    "Pay your way",
    "Card, Apple Pay or Google Pay here, or at the counter.",
  ],
  ["3", "Plug in", "Watch it charge live. We say when to move your car."],
];

export default function Home() {
  const s = settings();
  return (
    <main className="wide landing">
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow">{brand.name} for forecourts and stores</p>
          <h1 id="hero-title">{brand.tagline}.</h1>
          <p className="lead">
            Drivers scan, pick a way to pay and plug in. Cashiers see every
            charger like a row of fuel pumps. No app or account for anyone.
          </p>
          <div className="row">
            {s.demo ? (
              <a className="button" href="#demo">
                Try the demo
              </a>
            ) : (
              <p className="notice">Scan the QR code on a charger to start.</p>
            )}
            <Link className="button secondary" href="/operator">
              Site staff sign in
            </Link>
          </div>
        </div>
        <div className="board hero-board" aria-hidden="true">
          <p className="muted">Charger</p>
          <div className="digits">3</div>
          <div className="row">
            <span className="pill ok">Ready</span>
            <span className="pill warn">Charging</span>
            <span className="pill bad">Move your car</span>
          </div>
        </div>
      </section>

      <section aria-labelledby="how-title">
        <h2 id="how-title">How it works</h2>
        <ol className="steps">
          {STEPS.map(([n, title, text]) => (
            <li key={n} className="card">
              <span className="step-no">{n}</span>
              <h3>{title}</h3>
              <p className="muted">{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="who-title">
        <h2 id="who-title">Who it is for</h2>
        <div className="grid wide-cols">
          <div className="card">
            <h3>Drivers</h3>
            <p className="muted">
              A clear price and estimate up front, a live session, and a receipt
              on the same page.
            </p>
          </div>
          <div className="card">
            <h3>Cashiers</h3>
            <p className="muted">
              A pump board on the store tablet: authorise, stop, take payment,
              print.
            </p>
          </div>
          <div className="card">
            <h3>Site staff</h3>
            <p className="muted">
              Prices per charger, today&apos;s sessions and revenue, and faults.
            </p>
          </div>
        </div>
      </section>

      {s.demo ? (
        <section className="card stack" id="demo" aria-labelledby="demo-title">
          <h2 id="demo-title">Try the demo: {DEMO_SITE_NAME}</h2>
          <p className="muted">
            Open a charger as if you had scanned its QR code. Nothing is
            charged.
          </p>
          <ul className="charger-list">
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
        </section>
      ) : null}
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
