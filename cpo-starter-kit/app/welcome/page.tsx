import Link from "next/link";
import { isDemo } from "@/lib/server/env";
import { brand } from "@/brand/brand";

export const metadata = { title: "Welcome" };

const FLOWS = [
  {
    title: "Set up in an afternoon",
    text: "A checklist walks you through your company, your brand on the driver pages and card payments.",
  },
  {
    title: "Run your chargers",
    text: "Add chargers, watch them live, start and stop sessions, and print QR stickers for the bays.",
  },
  {
    title: "Get paid",
    text: "Set prices, let drivers scan, pay by card and charge. Reports show what was collected.",
  },
];

const WHO = [
  "A small operator with a handful of sites",
  "Owner and staff on a laptop; drivers on a phone",
  "No payment or charger code to write",
];

/** The public landing page: what the kit does, who it is for, and the way in. */
export default function Page() {
  const demo = isDemo();
  return (
    <>
      <section className="hero" aria-labelledby="hero-heading">
        <p className="eyebrow">{brand.name}</p>
        <h1 id="hero-heading">{brand.tagline}</h1>
        <p className="lede">
          Chargers, prices, live sessions, reports and your team in one calm
          place, with your own brand on the pages drivers pay on.
        </p>
        <div className="actions">
          {demo ? (
            <Link className="button" href="/">
              Try the demo
            </Link>
          ) : (
            <Link className="button" href="/login">
              Sign in
            </Link>
          )}
          <a className="button secondary" href="#flows">
            See how it works
          </a>
        </div>
        {demo && (
          <p className="muted">
            The demo uses sample data. Nothing is sent to chargers, payment
            providers or email.
          </p>
        )}
      </section>
      <section id="flows" className="feature-grid" aria-label="Main flows">
        {FLOWS.map((f) => (
          <article key={f.title} className="card">
            <h2>{f.title}</h2>
            <p>{f.text}</p>
          </article>
        ))}
      </section>
      <section className="card" aria-labelledby="who-heading">
        <h2 id="who-heading">Who it is for</h2>
        <ul className="rows">
          {WHO.map((w) => (
            <li key={w}>
              <span className="name">{w}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
