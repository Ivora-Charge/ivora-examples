import type { Metadata } from "next";
import { isDemo } from "@/lib/server/demo";
import { MAX_RECONCILIATION_DAYS } from "@/lib/sessions/reconcile";
import { sessionStore } from "@/lib/sessions/registry";
import { Head } from "../ui/kit";
import { Gated } from "../ui/parts";
import { ReconciliationAdmin } from "./reconciliation-admin";

export const metadata: Metadata = { title: "Reconciliation" };

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
  // Only the days of the built-in demo samples, which every visitor of a demo sees.
  const days = await defaultDays();
  return (
    <>
      <Head
        crumbs={["Money"]}
        title="Reconciliation"
        lead={`Per peer and UTC day: the sessions the CPO reported, the CDRs it billed, and what drivers' cards were charged for them. At most ${MAX_RECONCILIATION_DAYS} days at a time.`}
      />
      <Gated what="reconcile CDRs">
        <ReconciliationAdmin from={days.from} to={days.to} demo={isDemo()} />
      </Gated>
    </>
  );
}
