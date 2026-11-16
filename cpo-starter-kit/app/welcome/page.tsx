import Link from "next/link";
import { isDemo, config } from "@/lib/server/env";
import { brand } from "@/brand/brand";
import { Icon } from "@/brand/icons";
import { PublicHeader } from "../public-header";
import { SummaryStrip } from "../ui/summary-strip";

export const metadata = { title: "Welcome" };

const CARDS = [
  {
    icon: "chargers",
    title: "Chargers",
    text: "Add, test and print stickers.",
  },
  {
    icon: "pricing",
    title: "Pricing",
    text: "Per kWh, idle fees, time of use or free.",
  },
  {
    icon: "reports",
    title: "Reports",
    text: "Sessions, energy, revenue; export anytime.",
  },
];

/**
 * The public landing page: what the app is and one way in. It reads no session and no
 * operator data beyond the operator's public name, so it is the same for every visitor.
 */
export default function Page() {
  const demo = isDemo();
  const cta = demo ? (
    <Link className="button" href="/">
      Try the demo
    </Link>
  ) : (
    <Link className="button" href="/login">
      Sign in
    </Link>
  );
  return (
    <>
      <PublicHeader toggle>{cta}</PublicHeader>
      <main id="main" tabIndex={-1} className="public-main landing">
        <section className="hero" aria-labelledby="hero-heading">
          <div>
            <p className="eyebrow">
              {brand.name} for {config.operatorName}
            </p>
            <h1 id="hero-heading">Run your chargers without a developer.</h1>
            <p className="lede">
              Chargers, prices, drivers&apos; card payments and reports in one
              place, on your own domain and in your own brand.
            </p>
            <div className="actions">{cta}</div>
            <p className="muted">
              {demo
                ? "The demo uses sample data. Nothing is sent to chargers, payment providers or email."
                : "Staff sign in with their work email. Drivers don't need an account: they scan the sticker on the charger."}
            </p>
          </div>
          <section className="card" aria-labelledby="today-heading">
            <h2 id="today-heading">Today</h2>
            <SummaryStrip
              label="Today, sample data"
              items={[
                { label: "Charging", value: 2 },
                { label: "Available", value: 3 },
              ]}
            />
            <p className="muted">Sample data</p>
          </section>
        </section>

        <ul className="feature-grid" aria-label="What is inside">
          {CARDS.map((c) => (
            <li key={c.title} className="card feature">
              <span className="feature-icon">
                <Icon name={c.icon} />
              </span>
              <h2>{c.title}</h2>
              <p>{c.text}</p>
            </li>
          ))}
        </ul>

        <footer className="landing-foot">
          <p className="muted">
            {brand.name} is a placeholder brand: the operator replaces its name,
            colours and logo in <code>brand/</code>.
          </p>
        </footer>
      </main>
    </>
  );
}
