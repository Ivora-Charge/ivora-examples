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
