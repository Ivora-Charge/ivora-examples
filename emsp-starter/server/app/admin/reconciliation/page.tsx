import type { Metadata } from "next";
import Link from "next/link";
import { DEMO_PEER_ID } from "@/lib/locations/registry";
import { adminEnabled } from "@/lib/server/admin";
import { isDemo } from "@/lib/server/demo";
import { MAX_RECONCILIATION_DAYS } from "@/lib/sessions/reconcile";
import { sessionStore } from "@/lib/sessions/registry";
import { ReconciliationAdmin } from "./reconciliation-admin";

export const metadata: Metadata = { title: "CDR reconciliation" };

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The last seven UTC days; in demo mode, the days of the sample sessions. */
async function defaultDays(): Promise<{ from: string; to: string }> {
  const today = Date.parse(`${day(Date.now())}T00:00:00Z`);
  const range = { from: day(today - 7 * 86_400_000), to: day(today) };
  if (!isDemo()) return range;
  const starts = (await sessionStore().listSessions({ limit: 100 })).map((s) =>
    Date.parse(s.session.start_date_time),
  );
  return starts.length
    ? { from: day(Math.min(...starts)), to: day(Math.max(...starts)) }
    : range;
}

export default async function ReconciliationPage() {
  const days = await defaultDays();
  return (
    <>
      <h1>CDR reconciliation</h1>
      <section className="card" aria-labelledby="about">
        <h2 id="about">Does every CPO agree with us?</h2>
        <p>
          Per CPO peer and UTC day: the sessions the CPO reported, the CDRs it
          billed, and what drivers&apos; cards were charged for those CDRs.
          Mismatches list the IDs to look at: completed sessions without a CDR,
          CDRs without a session, of a token we did not issue or in another
          currency, CDRs of our drivers with no payment, and payments that
          captured something else than the CDR total. Payments flagged for
          review are listed below them. At most {MAX_RECONCILIATION_DAYS} days
          at a time.
        </p>
        {isDemo() && (
          <p className="note">
            Demo mode: the mock CPO&apos;s sample sessions and CDRs (peer ID{" "}
            <code>{DEMO_PEER_ID}</code>), kept in memory. Its CDRs are of sample
            tokens, so they show as not ours.
          </p>
        )}
        <p className="note">
          Needs an admin signed in (<Link href="/admin/sign-in">sign in</Link>)
          {adminEnabled() ? ", or the server's ADMIN_SECRET." : "."}
        </p>
      </section>
      <ReconciliationAdmin from={days.from} to={days.to} />
    </>
  );
}
