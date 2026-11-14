import Link from "next/link";
import { notFound } from "next/navigation";
import { demoSession, DEMO_SESSION_IDS } from "@/lib/demo-session";
import { getCheckout, loadReturnedSession } from "@/lib/server/checkout";
import type { ReturnedSession } from "@/lib/server/checkout";
import { config, isDemo } from "@/lib/server/env";
import { Loading } from "@/app/loading-skeleton";
import { StatusChip } from "@/app/ui/status-chip";
import type { ChipTone } from "@/lib/status-chips";
import { AutoRefresh } from "../../c/[code]/refresh";
import { StartSession, StopSession } from "./forms";

export const metadata = { title: "Your charging session" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STEPS = [
  ["starting", "Starting"],
  ["charging", "Charging"],
  ["stopping", "Stopping"],
  ["finished", "Finished"],
] as const;

const STAGE_TONE: Record<string, ChipTone> = {
  starting: "busy",
  charging: "live",
  stopping: "busy",
  finished: "ok",
  not_charged: "idle",
};

function Session({ s, demo }: { s: ReturnedSession; demo: boolean }) {
  const step =
    s.stage === "not_charged" ? -1 : STEPS.findIndex(([k]) => k === s.stage);
  return (
    <>
      {s.live && !demo && <AutoRefresh seconds={5} />}
      {demo && (
        <p className="notice" role="note">
          Demo session: sample data only. No card was used, nothing was charged
          and no charger was contacted.
        </p>
      )}
      <header className="card charge-board">
        <div className="chead">
          <h1 id="session-heading">{s.label}</h1>
          <StatusChip tone={STAGE_TONE[s.stage] ?? "idle"}>
            {s.label}
          </StatusChip>
        </div>
        {s.place && <p className="muted">{s.place}</p>}
      </header>
      {step >= 0 && (
        <ol className="steps" aria-label="Session progress">
          {STEPS.map(([k, label], i) => (
            <li key={k}>
              <span aria-current={i === step ? "step" : undefined}>
                <span className="step-number" aria-hidden="true">
                  {i + 1}
                </span>
                {label}
                {i < step && <span className="step-done">Done</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
      <section className="card stack" aria-labelledby="session-heading">
        <p>{s.detail}</p>
        {(s.energyKwh || s.cost) && (
          <dl className="facts session-facts" aria-label="Session so far">
            {s.energyKwh && (
              <div className="big-figure">
                <dt>Energy</dt>
                <dd data-testid="session-energy">{s.energyKwh} kWh</dd>
              </div>
            )}
            {s.cost && (
              <div>
                <dt>Cost so far</dt>
                <dd data-testid="session-cost">{s.cost}</dd>
              </div>
            )}
          </dl>
        )}
        {s.notice && (
          <p className="notice" role="note">
            {s.notice}
          </p>
        )}
        {s.canStart && (demo ? null : <StartSession id={s.id} />)}
        {s.canStop &&
          (demo ? (
            <Link className="button secondary block" href="/s/demo-stopping">
              Stop charging
            </Link>
          ) : (
            <StopSession id={s.id} />
          ))}
        {demo && s.stage === "stopping" && (
          <Link className="button secondary block" href="/s/demo-finished">
            Show the receipt
          </Link>
        )}
      </section>
      {s.receipt && (
        <section className="card" aria-labelledby="receipt-heading">
          <h2 id="receipt-heading">Receipt</h2>
          <dl className="facts">
            {s.receipt.energyKwh && (
              <div>
                <dt>Energy</dt>
                <dd>{s.receipt.energyKwh} kWh</dd>
              </div>
            )}
            <div>
              <dt>Final bill</dt>
              <dd>{s.receipt.total}</dd>
            </div>
            <div>
              <dt>Charged</dt>
              <dd data-testid="receipt-charged">{s.receipt.charged}</dd>
            </div>
            <div>
              <dt>Hold released</dt>
              <dd>
                {s.receipt.released} of {s.receipt.hold}
              </dd>
            </div>
          </dl>
          <p className="muted">
            {demo
              ? "Demo receipt: no card was charged and no money moved."
              : "Stripe emails you the receipt for the card payment."}
          </p>
        </section>
      )}
      {demo && (
        <nav className="card" aria-label="Demo: other session states">
          <h2>Demo: see each state</h2>
          <ul>
            {DEMO_SESSION_IDS.map((id) => (
              <li key={id}>
                <Link href={`/s/${id}`}>{id.replace("demo-", "")}</Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </>
  );
}

async function Content({
  id,
  canceled,
  stopping,
}: {
  id: string;
  canceled: boolean;
  stopping: boolean;
}) {
  const s = await loadReturnedSession(
    getCheckout(),
    id,
    { canceled, stopping },
    config.operatorName,
  );
  if (!s) notFound();
  return <Session s={s} demo={false} />;
}

/**
 * Where drivers land after Ivora's hosted checkout (the payment's return_url, on the
 * operator's own verified domain): the live session, Stop, and the receipt. Public:
 * the random ID in the address is the only thing it needs. An unknown ID answers 404
 * before anything streams. Demo mode shows sample sessions and calls nothing.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ canceled?: string; stopping?: string }>;
}) {
  const { id } = await params;
  if (isDemo()) {
    const s = demoSession(id);
    if (!s) notFound();
    return <Session s={s} demo />;
  }
  const q = await searchParams;
  const rec = UUID.test(id)
    ? await getCheckout().store.getById(id.toLowerCase())
    : null;
  if (!rec || rec.kind !== "paid") notFound();
  return (
    <Loading shape="driver">
      <Content
        id={id}
        canceled={q.canceled === "1"}
        stopping={q.stopping === "1"}
      />
    </Loading>
  );
}
