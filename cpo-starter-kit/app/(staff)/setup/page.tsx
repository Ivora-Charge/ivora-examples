import Link from "next/link";
import { config, isDemo } from "@/lib/server/env";
import { getTeam } from "@/lib/server/team";
import { SetupForm } from "./form";

export const metadata = { title: "Set up" };

export default async function Page() {
  if (isDemo())
    return (
      <>
        <h1>Set up</h1>
        <section className="card">
          <p className="notice" role="note">
            Demo mode: there is nothing to set up. In live mode this screen
            creates the first owner, once, with the setup secret from the
            deployment&apos;s environment variables.
          </p>
          <h2>Make it yours</h2>
          <p>
            Everything here is sample data: nothing is sent to Ivora, chargers,
            payment providers or email. To go live, add your Ivora API key in
            your deployment&apos;s environment variables (for example Vercel
            Project Settings → Environment Variables, or <code>.env.local</code>{" "}
            locally); the kit has no in-app key entry. Live mode also needs
            Supabase. The README lists every variable. The placeholder brand
            (name, logo, colours) is replaced in <code>brand/</code>.
          </p>
          <Link className="button" href="/team">
            See the demo team
          </Link>
        </section>
      </>
    );

  if (await getTeam().backend.hasStaff())
    return (
      <>
        <h1>Set up</h1>
        <section className="card">
          <p>
            Setup is done. Everyone else joins by invite from the Team page.
          </p>
          <Link className="button" href="/login">
            Sign in
          </Link>
        </section>
      </>
    );

  return (
    <>
      <h1>Set up</h1>
      <section className="card" aria-labelledby="owner-heading">
        <h2 id="owner-heading">Create the first owner</h2>
        <p className="muted">
          This works once. Enter the <code>SETUP_SECRET</code> from your
          deployment&apos;s environment variables. After this, everyone joins by
          invite.
        </p>
        <SetupForm operatorName={config.operatorName} />
      </section>
    </>
  );
}
