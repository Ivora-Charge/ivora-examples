import type { Metadata } from "next";
import Link from "next/link";
import { adminEnabled } from "@/lib/server/admin";
import { isDemo } from "@/lib/server/demo";
import { ProblemAdmin } from "./problem-admin";

export const metadata: Metadata = { title: "Reported problems" };

export default function ProblemsPage() {
  return (
    <>
      <h1>Reported problems</h1>
      <section className="card" aria-labelledby="about">
        <h2 id="about">What drivers tell you</h2>
        <p>
          Drivers report a problem at a charger from the app: what went wrong,
          their words and, if they took one, a photo. Pass charger faults on to
          the CPO; look up payments on{" "}
          <Link href="/admin/payments">Payments and refunds</Link> and the
          driver on <Link href="/admin/tokens">Drivers and tokens</Link>.
        </p>
        {isDemo() && (
          <p className="note">
            Demo mode: reports are kept in memory only, until the server
            restarts.
          </p>
        )}
        <p className="note">
          Lists need an admin signed in (
          <Link href="/admin/sign-in">sign in</Link>)
          {adminEnabled() ? ", or the server's ADMIN_SECRET." : "."}
        </p>
      </section>
      <ProblemAdmin />
    </>
  );
}
