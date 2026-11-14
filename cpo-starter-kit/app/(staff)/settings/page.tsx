import Link from "next/link";
import { atLeast } from "@/lib/roles";
import { publicBase } from "@/lib/server/checkout";
import { loadReturnDomain } from "@/lib/server/onboarding/return-domain";
import { requireRole } from "@/lib/server/auth";
import {
  getOnboarding,
  loadOnboarding,
  loadStripe,
} from "@/lib/server/onboarding";
import { getTeam, loadTeam } from "@/lib/server/team";
import { describeError } from "@/lib/server/ivora";
import { PageHeader } from "@/app/ui/page-header";
import {
  BrandSection,
  CompanySection,
  DemoReset,
  NoAccess,
  PaymentsSection,
  ReturnDomainSection,
  TeamSection,
} from "../onboarding/sections";
import { Loading } from "@/app/loading-skeleton";

export const metadata = { title: "Settings" };

async function Content() {
  const me = await requireRole("viewer");
  if (!atLeast(me.role, "manager")) return <NoAccess title="Settings" />;
  const d = getOnboarding();
  const [o, stripe, domain, team] = await Promise.all([
    loadOnboarding(d, me),
    loadStripe(d),
    loadReturnDomain(d, publicBase(), me.demo),
    loadTeam(getTeam(), me).then(
      (t) => ({ ok: true as const, ...t }),
      (e) => ({ ok: false as const, error: describeError(e) }),
    ),
  ]);
  const steps = [
    { id: "company", label: "Company", done: o.companyDone },
    { id: "brand", label: "Brand", done: o.brandDone },
    {
      id: "payments",
      label: "Payments",
      done: stripe.ok && stripe.view.state === "ready",
    },
  ];
  const next = steps.find((x) => !x.done);
  const doneCount = steps.filter((x) => x.done).length;
  return (
    <>
      <PageHeader
        title="Settings"
        description="Company, brand, payments and team. Each section saves on its own."
      />
      {next && (
        <div className="note" role="status">
          <span>
            <b>
              {doneCount} of {steps.length} setup steps done.
            </b>{" "}
            {next.label} is next.
          </span>
          <Link className="button secondary" href={`#${next.id}`}>
            Go to {next.label}
          </Link>
        </div>
      )}
      <ol className="steps" aria-label="Setup progress">
        {steps.map((x) => (
          <li
            key={x.id}
            aria-current={x === next ? "step" : undefined}
            className={x.done ? "step-item done" : "step-item"}
          >
            <span className="step-number" aria-hidden="true">
              {x.done ? "✓" : steps.indexOf(x) + 1}
            </span>
            {x.label}
            {x.done && <span className="step-done">Done</span>}
          </li>
        ))}
      </ol>
      <nav className="settings-nav" aria-label="Settings sections">
        <a href="#company">Company</a>
        <a href="#brand">Brand</a>
        <a href="#payments">Payments</a>
        <a href="#team">Team</a>
        <a href="#roaming">Roaming</a>
      </nav>
      <CompanySection o={o} id="company" />
      <BrandSection o={o} demo={me.demo} id="brand" />
      <PaymentsSection stripe={stripe} demo={me.demo} id="payments" />
      <TeamSection
        id="team"
        demo={me.demo}
        members={team.ok ? team.members : null}
        invites={team.ok ? team.invites : []}
        error={team.ok ? undefined : team.error}
      />
      <ReturnDomainSection result={domain} />
      <section
        className="card"
        id="roaming"
        aria-labelledby="roaming-link-heading"
      >
        <h2 id="roaming-link-heading">
          Roaming <span className="badge">Placeholder</span>
        </h2>
        <p className="muted">
          Publish your sites to OCPI roaming partners, and request your own
          party ID.
        </p>
        <p>
          <Link className="button secondary" href="/settings/roaming">
            Roaming settings
          </Link>
        </p>
      </section>
      <section className="card" aria-labelledby="keys-heading">
        <h2 id="keys-heading">API keys and services</h2>
        <p className="muted">
          The Ivora API key, Supabase and email settings are your
          deployment&apos;s environment variables (for example Vercel Project
          Settings → Environment Variables), never entered in the app. See the
          README.
        </p>
      </section>
      {me.demo && <DemoReset />}
    </>
  );
}

/** Checks the role first (a real redirect), then the page behind its loading skeleton. */
export default async function Page() {
  await requireRole("viewer");
  return (
    <Loading shape="list">
      <Content />
    </Loading>
  );
}
