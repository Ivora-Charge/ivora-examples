import { isDemo } from "@/lib/server/config";
import { brand, landing } from "../../brand/brand";
import DemoBanner from "./demo-banner";

const ICONS = [
  // plug
  "M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4",
  // pulse
  "M2 12h5l3-8 4 16 3-8h5",
  // checklist
  "M4 6l2 2 3-3M12 7h8M4 13l2 2 3-3M12 14h8M4 20l2 2 3-3M12 21h8",
];

export default function Landing() {
  const demo = isDemo();
  return (
    <main id="main">
      {demo && <DemoBanner />}
      <section className="hero">
        <p className="eyebrow">{brand.tagline}</p>
        <h1>{landing.headline}</h1>
        <p className="lead">{landing.who}</p>
        <a className="button big" href="/commission">
          {demo ? "Try the demo" : "Open the app"}
        </a>
        <p className="muted">
          {demo
            ? "Runs offline with a simulated charger. Nothing is sent anywhere."
            : "Sign in with the operator password."}
        </p>
      </section>
      <h2 className="sr">How it works</h2>
      <ol className="flows">
        {landing.flows.map((f, i) => (
          <li key={f.title}>
            <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
              <path
                d={ICONS[i]}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <h3>
              {i + 1}. {f.title}
            </h3>
            <p>{f.text}</p>
          </li>
        ))}
      </ol>
    </main>
  );
}
