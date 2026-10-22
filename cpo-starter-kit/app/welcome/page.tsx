import Link from "next/link";
import { isDemo, config } from "@/lib/server/env";
import { visibleModules } from "@/lib/modules";
import { brand } from "@/brand/brand";
import { Icon } from "@/brand/icons";
import { Logo } from "@/brand/Logo";
import { PublicHeader } from "../public-header";

export const metadata = { title: "Welcome" };

const FLOWS = [
  {
    icon: "onboarding",
    title: "Set up in an afternoon",
    text: "A checklist walks you through your company, your brand on the driver pages and card payments.",
  },
  {
    icon: "chargers",
    title: "Run your chargers",
    text: "Add chargers, watch them live, start and stop sessions, and print QR stickers for the bays.",
  },
  {
    icon: "pricing",
    title: "Get paid",
    text: "Set prices; drivers scan, pay by card and charge. Reports show what was collected.",
  },
];

const WHO = [
  ["A small operator", "A car park, a hotel or a few retail sites."],
  ["Owner and staff", "On a laptop, each with the access their role needs."],
  ["Drivers", "On their phone: scan, pay by card, charge. No app."],
];

/** Invented figures for the picture of the app; nothing here is read from a server. */
const MOCK_BARS = [46, 58, 41, 66, 74, 92, 62];
const MOCK_ROWS = [
  ["Bay 1", "Charging", "busy"],
  ["Bay 2", "Available", "ok"],
  ["Bay 3", "Offline", "off"],
];

/** A picture of the Overview, drawn with the brand tokens so it follows the theme. */
function ProductShot() {
  return (
    <figure className="shot">
      <div className="shot-frame" aria-hidden="true">
        <div className="shot-side">
          <Logo size={22} />
          {["overview", "live", "chargers", "pricing", "reports"].map(
            (s, i) => (
              <span key={s} className={i === 0 ? "current" : undefined}>
                <Icon name={s} />
              </span>
            ),
          )}
        </div>
        <div className="shot-body">
          <p className="shot-title">Overview</p>
          <div className="shot-kpis">
            <p>
              <span>Charging now</span>3
            </p>
            <p>
              <span>Online</span>5 / 6
            </p>
            <p>
              <span>Energy, 7 days</span>1,284 kWh
            </p>
          </div>
          <div className="shot-chart">
            {MOCK_BARS.map((h, i) => (
              <span
                key={i}
                className={i === 5 ? "peak" : undefined}
                style={{ height: `${h}%` }}
              />
            ))}
          </div>
          <ul className="shot-rows">
            {MOCK_ROWS.map(([name, label, tone]) => (
              <li key={name}>
                {name}
                <span className={`pill ${tone}`}>{label}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <figcaption className="muted">
        The Overview: live status, energy and the setup checklist. Figures are
        illustrative.
      </figcaption>
    </figure>
  );
}

/**
 * The public landing page: what the kit does, who it is for and the way in. It reads
 * no session and no operator data beyond the operator's public name, so it is the same
 * for every visitor.
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
  const modules = visibleModules({ fleet: config.fleetModule });
  return (
    <>
      <PublicHeader toggle>{cta}</PublicHeader>
      <main id="main" tabIndex={-1} className="public-main landing">
        <section className="hero" aria-labelledby="hero-heading">
          <div>
            <p className="eyebrow">
              {brand.name} for {config.operatorName}
            </p>
            <h1 id="hero-heading">{brand.tagline}</h1>
            <p className="lede">
              Chargers, prices, live sessions, reports and your team in one calm
              place, with your own brand on the pages drivers pay on.
            </p>
            <div className="actions">
              {cta}
              <a className="button secondary" href="#flows">
                See how it works
              </a>
            </div>
            <p className="muted">
              {demo
                ? "The demo uses sample data. Nothing is sent to chargers, payment providers or email."
                : "Staff sign in with their work email. Drivers don't need an account: they scan the sticker on the charger."}
            </p>
          </div>
          <ProductShot />
        </section>

        <section id="flows" aria-labelledby="flows-heading">
          <h2 id="flows-heading" className="section-title">
            Three steps from fork to first payment
          </h2>
          <ol className="feature-grid">
            {FLOWS.map((f, i) => (
              <li key={f.title} className="card feature">
                <span className="feature-icon">
                  <Icon name={f.icon} />
                </span>
                <h3>
                  <span className="muted">{i + 1}.</span> {f.title}
                </h3>
                <p>{f.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section
          className="landing-pair"
          aria-label="Who it is for and what is inside"
        >
          <div className="card">
            <h2>Who it is for</h2>
            <dl className="who-list">
              {WHO.map(([t, d]) => (
                <div key={t}>
                  <dt>{t}</dt>
                  <dd>{d}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="card">
            <h2>What is inside</h2>
            <ul className="module-list">
              {modules.map((m) => (
                <li key={m.slug}>
                  <Icon name={m.slug} />
                  <span>
                    <strong>{m.label}</strong>
                    <span className="muted">{m.summary}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <footer className="landing-foot">
          <p className="muted">
            {brand.name} is a placeholder brand: the operator replaces its name,
            colours and logo in <code>brand/</code>.
          </p>
          <a className="button secondary" href="#main">
            Back to top
          </a>
        </footer>
      </main>
    </>
  );
}
