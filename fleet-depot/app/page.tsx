import { brand } from "@/brand/brand";
import { gate } from "@/lib/auth";
import { isDemo } from "@/lib/config";
import { HowItWorks } from "./api-panel";

export const dynamic = "force-dynamic";

const FLOWS = [
  {
    title: "Departures first",
    body: "One row per vehicle on a shared time axis: energy delivered, the planned charge, and a tick at departure. At-risk vehicles are marked with a triangle, not just a colour.",
  },
  {
    title: "Inside the site cap",
    body: "A single gauge shows power against the cap and how many kW are free. The charging logic is unchanged; this screen only shows it.",
  },
  {
    title: "Cost per vehicle",
    body: "Each month's energy and cost by vehicle or driver, with a CSV download for the books.",
  },
];

export default function Landing() {
  const demo = isDemo();
  const missing = gate().mode === "missing";
  return (
    <main id="main" className="landing">
      {demo && (
        <div className="banner" role="status">
          <b>Demo</b>: simulated depot with sample vehicles and drivers. No
          charger commands or API requests are sent.
        </div>
      )}
      <section className="hero-land">
        <div>
          <h1>{brand.tagline}.</h1>
          <p>
            {brand.name} is a depot console for fleet and depot managers: see
            every vehicle against its departure time, keep total power under the
            site cap, and put the overview on a wall screen. Drivers check one
            card for "is my van ready, and when do I leave".
          </p>
          <div className="cta">
            <a className="btn primary" href="/depot">
              {demo ? "Try the demo" : "Open the depot"}
            </a>
            {missing && (
              <span className="warn">Setup needed: see the README.</span>
            )}
          </div>
        </div>
        <svg
          className="preview panel"
          viewBox="0 0 320 150"
          role="img"
          aria-label="Example departure timeline: three vehicles, each with delivered energy, planned charge and a departure tick"
        >
          {[0, 1, 2].map((i) => (
            <g key={i} transform={`translate(0 ${20 + i * 42})`}>
              <line
                x1="16"
                x2="304"
                y1="12"
                y2="12"
                stroke="var(--line)"
                strokeDasharray="2 3"
              />
              <rect
                x="16"
                y="5"
                width={60 + i * 20}
                height="14"
                rx="2"
                fill="var(--accent)"
              />
              <rect
                x={76 + i * 20}
                y="5"
                width={110 - i * 30}
                height="14"
                rx="2"
                fill="none"
                stroke="var(--accent)"
                strokeDasharray="3 2"
              />
              <rect
                x={250 - i * 28}
                y="0"
                width="2"
                height="24"
                fill="var(--ink)"
              />
            </g>
          ))}
          <line
            x1="76"
            x2="76"
            y1="8"
            y2="146"
            stroke="var(--accent)"
            strokeWidth="2"
          />
        </svg>
      </section>
      <ul className="features" aria-label="Main flows">
        {FLOWS.map((f) => (
          <li key={f.title}>
            <h2>{f.title}</h2>
            <p>{f.body}</p>
          </li>
        ))}
      </ul>
      <section className="panel how-panel" aria-labelledby="how-h">
        <h2 id="how-h">How it works on Ivora</h2>
        <ul className="topics">
          <li>
            <b>Smart charging profiles.</b> The app sets a limit per session so
            the depot stays under its cap.
          </li>
          <li>
            <b>RFID cards.</b> Drivers&apos; cards are authorised through the
            token list.
          </li>
          <li>
            <b>Webhooks.</b> Plug-in and session events tell the app when to
            replan.
          </li>
        </ul>
        <HowItWorks />
        <p>
          <a
            href="https://ivoracharge.com/developers"
            target="_blank"
            rel="noreferrer"
          >
            Ivora API docs
          </a>
        </p>
      </section>
    </main>
  );
}
