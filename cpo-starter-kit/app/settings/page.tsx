import Link from "next/link";
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
} from "../onboarding/sections";

export const metadata = { title: "Settings" };

export default async function Page() {
  const me = await requireRole("viewer");
  if (!atLeast(me.role, "manager")) return <NoAccess title="Settings" />;
  const d = getOnboarding();
  const [o, stripe] = await Promise.all([loadOnboarding(d, me), loadStripe(d)]);
  return (
    <>
      <h1>Settings</h1>
      <CompanySection o={o} />
      <BrandSection o={o} demo={me.demo} />
      <PaymentsSection stripe={stripe} demo={me.demo} />
      <section className="card" aria-labelledby="roaming-link-heading">
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
