import { DEFAULT_CURRENCY } from "@/lib/money";
import { ROLE_LABELS } from "@/lib/roles";
import type { Member, PendingInvite } from "@/lib/server/team";
import { StatusChip } from "@/app/ui/status-chip";
import type { ChipTone } from "@/lib/status-chips";
import Link from "next/link";
import { CURRENCIES, TIME_ZONES } from "@/lib/locale-options";
import { config } from "@/lib/server/env";
import { DEMO_STRIPE_STATES } from "@/lib/server/ivora/demo";
import type {
  Onboarding,
  StripeResult,
  StripeState,
} from "@/lib/server/onboarding";
import type { StripeView } from "@/lib/server/onboarding/stripe";
import { STRIPE_LABELS } from "@/lib/server/onboarding/stripe";
import {
  refreshStripeAction,
  resetDemoOnboardingAction,
  simulateStripeAction,
} from "./actions";
import type {
  ReturnDomainResult,
  ReturnDomainState,
} from "@/lib/server/onboarding/return-domain";
import {
  BrandForm,
  CompanyForm,
  PushBranding,
  ReturnDomainButton,
} from "./forms";

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

export function CompanySection({ o, id }: { o: Onboarding; id?: string }) {
  const p = o.profile;
  return (
    <section id={id} className="card" aria-labelledby="company-heading">
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
          currency: p.currency || DEFAULT_CURRENCY,
        }}
        timeZones={TIME_ZONES}
        currencies={CURRENCIES}
      />
    </section>
  );
}

export function BrandSection({
  o,
  demo,
  id,
}: {
  o: Onboarding;
  demo: boolean;
  id?: string;
}) {
  const p = o.profile;
  const logo = safeLogo(p.logoUrl);
  return (
    <section id={id} className="card" aria-labelledby="brand-heading">
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
      <p className="muted">
        This app&apos;s own name, logo and fonts are the Ampleaf placeholder
        brand: replace them in the <code>brand/</code> folder (see the README,
        &quot;Make it yours&quot;).
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
          <BrandForm
            color={p.primaryColor}
            hasLogo={Boolean(logo)}
            name={p.name}
          />
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

/** What is done, to do and waiting on the way to card payments, each a word and a chip. */
function PaymentSteps({ view }: { view: StripeView }) {
  const connected = view.state !== "none";
  const ready = view.state === "ready";
  const open = view.requirements.length > 0 || view.state === "pending";
  const steps: [string, ChipTone, string][] = [
    [
      "Stripe account connected",
      connected ? "ok" : "warn",
      connected ? "Done" : "To do",
    ],
    [
      "Details Stripe asks for",
      !connected ? "idle" : open ? "warn" : "ok",
      !connected ? "Waiting" : open ? "To do" : "Done",
    ],
    [
      "Ready for card payments",
      ready ? "ok" : "idle",
      ready ? "Done" : "Waiting",
    ],
  ];
  return (
    <ul className="pay-steps" aria-label="Payments checklist">
      {steps.map(([label, tone, word]) => (
        <li key={label}>
          <StatusChip tone={tone}>{word}</StatusChip> {label}
        </li>
      ))}
    </ul>
  );
}

export function PaymentsSection({
  stripe,
  demo,
  id,
}: {
  stripe: StripeResult;
  demo: boolean;
  id?: string;
}) {
  const v = stripe.ok ? stripe.view : null;
  return (
    <section id={id} className="card" aria-labelledby="payments-heading">
      <h2 id="payments-heading">
        Card payments (Stripe via Ivora Checkout)
        {v && <span className={PILL[v.state]}>{v.label}</span>}
      </h2>
      {stripe.ok ? (
        <>
          <p>{stripe.view.detail}</p>
          <PaymentSteps view={stripe.view} />
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
        <>
          <p>
            Stripe is connected in your Ivora dashboard, not in this app: open
            your project&apos;s settings there and connect Stripe (or finish
            what Stripe asks for). Then come back and check again. This app
            never sees or stores Stripe keys.
          </p>
          <p>
            <a
              className="button"
              href={config.stripeSettingsUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open your Ivora dashboard
            </a>
          </p>
        </>
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

const DOMAIN_PILL: Record<ReturnDomainState, [string, string]> = {
  demo: ["pill off", "Sample"],
  no_origin: ["pill off", "Not set"],
  not_registered: ["pill off", "Not registered"],
  pending: ["pill warn", "Waiting for the TXT record"],
  ready: ["pill ok", "Verified"],
};

/**
 * The return domain: the hostname drivers come back to after Ivora's hosted checkout,
 * to the kit's own session page (/s/<id>). Optional: without it they return to Ivora's
 * driver page.
 */
export function ReturnDomainSection({
  result,
}: {
  result: ReturnDomainResult;
}) {
  const v = result.ok ? result.view : null;
  return (
    <section className="card" aria-labelledby="return-domain-heading">
      <h2 id="return-domain-heading">
        Return domain
        {v && (
          <span className={DOMAIN_PILL[v.state][0]}>
            {DOMAIN_PILL[v.state][1]}
          </span>
        )}
      </h2>
      <p className="muted">
        After paying, drivers come back to your own page (<code>/s/…</code> on
        your domain) to follow their session, stop it and see the receipt. Ivora
        only sends them to a hostname you proved you own. Optional: until it is
        verified they return to Ivora&apos;s driver page.
      </p>
      {result.ok ? (
        <>
          <p>{result.view.detail}</p>
          {result.view.hostname && (
            <dl className="facts">
              <div>
                <dt>Hostname</dt>
                <dd>
                  <code>{result.view.hostname}</code>
                </dd>
              </div>
              {result.view.txt && (
                <>
                  <div>
                    <dt>TXT record name</dt>
                    <dd>
                      <code>{result.view.txt.name}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>TXT record value</dt>
                    <dd>
                      <code>{result.view.txt.value}</code>
                    </dd>
                  </div>
                </>
              )}
            </dl>
          )}
          {result.view.state === "not_registered" && (
            <ReturnDomainButton verify={false} />
          )}
          {result.view.state === "pending" && <ReturnDomainButton verify />}
        </>
      ) : (
        <p className="error" role="alert">
          {result.error}
        </p>
      )}
    </section>
  );
}

/** Settings: who is on the team, with a link to manage it (the Team page does the changes). */
export function TeamSection({
  members,
  invites = [],
  error,
  demo,
  id,
}: {
  id?: string;
  members: Member[] | null;
  invites?: PendingInvite[];
  error?: string;
  demo: boolean;
}) {
  return (
    <section id={id} className="card" aria-labelledby="team-heading">
      <div className="chead">
        <h2 id="team-heading">
          Team
          {demo && <span className="badge">Sample</span>}
        </h2>
        <Link className="button secondary" href="/team">
          Manage team
        </Link>
      </div>
      {members === null ? (
        <p className="error" role="alert">
          {error ?? "The team could not be read."} Nothing was changed.
        </p>
      ) : (
        <ul className="rows" aria-label="Team">
          {members.map((m) => (
            <li key={m.userId}>
              <span className="name">{m.email}</span>
              <span className="role">{ROLE_LABELS[m.role]}</span>
              <StatusChip tone="ok">Active</StatusChip>
            </li>
          ))}
          {invites.map((i) => (
            <li key={i.id}>
              <span className="name">{i.email}</span>
              <span className="role">{ROLE_LABELS[i.role]}</span>
              <StatusChip tone="idle">Invited</StatusChip>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
