import Link from "next/link";
import { redirect } from "next/navigation";
import { atLeast } from "@/lib/roles";
import { requireRole } from "@/lib/server/auth";
import {
  getOnboarding,
  loadOnboarding,
  loadStripe,
} from "@/lib/server/onboarding";
import {
  BrandSection,
  CompanySection,
  DemoReset,
  NoAccess,
  PaymentsSection,
} from "./sections";
import { Loading } from "@/app/loading-skeleton";

export const metadata = { title: "Onboarding" };

const STEPS = [
  { key: "company", label: "Company" },
  { key: "brand", label: "Brand" },
  { key: "payments", label: "Payments" },
] as const;
type Step = (typeof STEPS)[number]["key"];

async function Content({
  searchParams,
}: {
  searchParams: Promise<{ step?: string | string[] }>;
}) {
  const me = await requireRole("viewer");
  if (!atLeast(me.role, "manager")) return <NoAccess title="Onboarding" />;
  const d = getOnboarding();
  const o = await loadOnboarding(d, me);
  const asked = (await searchParams).step;
  const first: Step = !o.companyDone
    ? "company"
    : !o.brandDone
      ? "brand"
      : "payments";
  const step = STEPS.find((s) => s.key === asked)?.key;
  // Start at the first open step. The step is always in the address, so saving a
  // form re-renders the same step (with its message) rather than jumping ahead.
  if (!step) redirect(`/onboarding?step=${first}`);
  const stripe = step === "payments" ? await loadStripe(d) : null;
  const done: Record<Step, boolean> = {
    company: o.companyDone,
    brand: o.brandDone,
    payments: stripe?.ok ? stripe.view.state === "ready" : false,
  };
  const index = STEPS.findIndex((s) => s.key === step);
  const next = STEPS[index + 1];

  return (
    <>
      <h1>Onboarding</h1>
      <p className="muted">
        Three steps to put your name on the driver payment pages and take card
        payments. You can change everything later in{" "}
        <Link href="/settings">Settings</Link>.
      </p>
      <nav aria-label="Setup steps">
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s.key}>
              <Link
                href={`/onboarding?step=${s.key}`}
                aria-current={s.key === step ? "step" : undefined}
              >
                <span className="step-number" aria-hidden="true">
                  {i + 1}
                </span>
                {s.label}
                {done[s.key] && <span className="step-done">Done</span>}
              </Link>
            </li>
          ))}
        </ol>
      </nav>
      {step === "company" && <CompanySection o={o} />}
      {step === "brand" && <BrandSection o={o} demo={me.demo} />}
      {step === "payments" && stripe && (
        <PaymentsSection stripe={stripe} demo={me.demo} />
      )}
      <p>
        {next ? (
          <Link
            className="button secondary"
            href={`/onboarding?step=${next.key}`}
          >
            Next: {next.label}
          </Link>
        ) : (
          <Link className="button secondary" href="/">
            Back to Overview
          </Link>
        )}
      </p>
      {me.demo && <DemoReset />}
    </>
  );
}

/** Checks the role first (a real redirect), then the page behind its loading skeleton. */
export default async function Page(props: Parameters<typeof Content>[0]) {
  await requireRole("viewer");
  return (
    <Loading shape="list">
      <Content {...props} />
    </Loading>
  );
}
