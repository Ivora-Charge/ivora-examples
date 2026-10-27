import { currencyOr } from "@/lib/money";
import { CURRENCIES, TIME_ZONES } from "@/lib/locale-options";
import { config } from "@/lib/server/env";
import { DEMO_STRIPE_STATES } from "@/lib/server/ivora/demo";
import type {
  Onboarding,
  StripeResult,
  StripeState,
} from "@/lib/server/onboarding";
import { STRIPE_LABELS } from "@/lib/server/onboarding/stripe";
import {
  refreshStripeAction,
  resetDemoOnboardingAction,
  simulateStripeAction,
} from "./actions";
import { BrandForm, CompanyForm, PushBranding } from "./forms";

// The onboarding steps, shared by the setup wizard (/onboarding) and Settings.

const PILL: Record<StripeState, string> = {
  none: "pill off",
  pending: "pill warn",
  pending_review: "pill warn",
  ready: "pill ok",
};

/** Only an https logo from Ivora is shown. */
const safeLogo = (url: string | null) =>
  url && url.startsWith("https://") ? url : null;

export function NoAccess({ title }: { title: string }) {
  return (
    <>
      <h1>{title}</h1>
      <section className="card" aria-labelledby="no-access-heading">
        <h2 id="no-access-heading">Owners and managers only</h2>
        <p className="muted">
          Company details, brand and payments are set up by an owner or a
          manager. Ask one of them if something here needs to change.
        </p>
      </section>
    </>
  );
}

export function CompanySection({ o }: { o: Onboarding }) {
  const p = o.profile;
  return (
    <section className="card" aria-labelledby="company-heading">
      <h2 id="company-heading">
        Company details
        {o.companyDone && <span className="pill ok">Done</span>}
      </h2>
      <CompanyForm
        defaults={{
          name: p.name ?? config.operatorName,
          supportEmail: p.supportEmail ?? "",
          supportUrl: p.supportUrl ?? "",
          website: p.website ?? "",
          timeZone: p.timeZone ?? "",
          currency: currencyOr(p.currency),
        }}
        timeZones={TIME_ZONES}
        currencies={CURRENCIES}
      />
    </section>
  );
}

export function BrandSection({ o, demo }: { o: Onboarding; demo: boolean }) {
  const p = o.profile;
  const logo = safeLogo(p.logoUrl);
  return (
    <section className="card" aria-labelledby="brand-heading">
      <h2 id="brand-heading">
        Brand
        {o.brandDone && <span className="pill ok">Done</span>}
      </h2>
      <p className="muted">
        Drivers who scan your QR codes pay on Ivora&apos;s payment pages, which
        show your name, colour, logo and support contacts. The card form itself
        is Stripe Checkout: its look comes from your Stripe account&apos;s
        branding settings.
      </p>
      {!p.name ? (
        <p className="notice">Save your company details first.</p>
      ) : (
        <>
          {p.primaryColor && !o.inSync && (
            <div className="notice" role="note">
              <p>
                The driver payment pages don&apos;t show the saved brand yet.
              </p>
              <PushBranding />
            </div>
          )}
          {logo && (
            <p className="logo-preview">
              {/* Served by Ivora, which checked its size: no optimiser needed. */}
              <img src={logo} alt={`${p.name ?? "Company"} logo`} />
            </p>
          )}
          <BrandForm color={p.primaryColor} hasLogo={Boolean(logo)} />
          {demo && (
            <p className="muted">
              Demo mode checks a logo but does not upload or keep it.
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function PaymentsSection({
  stripe,
  demo,
}: {
  stripe: StripeResult;
  demo: boolean;
}) {
  const v = stripe.ok ? stripe.view : null;
  return (
    <section className="card" aria-labelledby="payments-heading">
      <h2 id="payments-heading">
        Card payments (Stripe via Ivora Checkout)
        {v && <span className={PILL[v.state]}>{v.label}</span>}
      </h2>
      {stripe.ok ? (
        <>
          <p>{stripe.view.detail}</p>
          <dl className="facts">
            {stripe.view.accountId && (
              <div>
                <dt>Stripe account</dt>
                <dd>
                  <code>{stripe.view.accountId}</code>
                </dd>
              </div>
            )}
            {stripe.view.livemode !== null && (
              <div>
                <dt>Mode</dt>
                <dd>{stripe.view.livemode ? "Live" : "Test"}</dd>
              </div>
            )}
            {stripe.view.disabledReason && (
              <div>
                <dt>Stripe says</dt>
                <dd>
                  <code>{stripe.view.disabledReason}</code>
                </dd>
              </div>
            )}
          </dl>
          {stripe.view.requirements.length > 0 && (
            <>
              <h3>Open requirements</h3>
              <ul aria-label="Open Stripe requirements">
                {stripe.view.requirements.map((r) => (
                  <li key={r}>
                    <code>{r}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : (
        <p className="error" role="alert">
          {stripe.error}
        </p>
      )}
      {v?.state !== "ready" || (v && v.requirements.length > 0) ? (
        <p>
          Stripe is connected in your Ivora dashboard, not in this app: open{" "}
          <a
            href={config.stripeSettingsUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            your Ivora dashboard
          </a>
          , go to your project&apos;s settings and connect Stripe (or finish
          what Stripe asks for). Then come back and check again. This app never
          sees or stores Stripe keys.
        </p>
      ) : null}
      <form action={refreshStripeAction}>
        <button type="submit" className="button secondary">
          Check status again
        </button>
      </form>
      {demo && (
        <form
          action={simulateStripeAction}
          className="form inline demo-sim"
          // Remount on each status, so the select shows the one now simulated.
          key={v ? demoValue(v.state, v.requirements.length) : "error"}
        >
          <div className="field">
            <label htmlFor="demo-stripe">Demo: simulate a Stripe status</label>
            <select
              id="demo-stripe"
              name="state"
              defaultValue={
                v ? demoValue(v.state, v.requirements.length) : "none"
              }
            >
              {DEMO_STRIPE_STATES.map((s) => (
                <option key={s} value={s}>
                  {DEMO_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="button secondary">
            Simulate
          </button>
        </form>
      )}
    </section>
  );
}

const DEMO_LABELS: Record<(typeof DEMO_STRIPE_STATES)[number], string> = {
  ...STRIPE_LABELS,
  ready_requirements: "Ready, with open requirements",
};

const demoValue = (state: StripeState, requirements: number) =>
  state === "ready" && requirements ? "ready_requirements" : state;

export function DemoReset() {
  return (
    <section className="card" aria-labelledby="demo-onboarding-heading">
      <h2 id="demo-onboarding-heading">Demo company</h2>
      <p className="muted">
        Your demo company is kept in your browser only and is never sent
        anywhere.
      </p>
      <form action={resetDemoOnboardingAction}>
        <button type="submit" className="button secondary">
          Reset the demo company
        </button>
      </form>
    </section>
  );
}
