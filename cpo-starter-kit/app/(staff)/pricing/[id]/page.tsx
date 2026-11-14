import Link from "next/link";
import { notFound } from "next/navigation";
import { TIME_ZONES } from "@/lib/locale-options";
import { formatMinor } from "@/lib/money";
import { requireRole } from "@/lib/server/auth";
import {
  defaultSimulation,
  editorValues,
  getPricing,
  idleGraceDefault,
  loadTariff,
} from "@/lib/server/pricing";
import { holdMinor, paidCurrencyNote } from "@/lib/server/pricing/tariff";
import { CrumbName } from "@/app/ui/shell-breadcrumbs";
import { PageHeader } from "@/app/ui/page-header";
import { StatusChip } from "@/app/ui/status-chip";
import { tariffType } from "@/lib/tariff-table";
import { When } from "../../chargers/status";
import { FinishTariff, TariffEditor } from "../forms";

export const metadata = { title: "Tariff" };

const DAY_NAMES: Record<string, string> = {
  MONDAY: "Mon",
  TUESDAY: "Tue",
  WEDNESDAY: "Wed",
  THURSDAY: "Thu",
  FRIDAY: "Fri",
  SATURDAY: "Sat",
  SUNDAY: "Sun",
};

/**
 * "Every day" when all seven days are set, otherwise the days as a list in stored
 * order, for example "Mon, Tue, Wed, Thu, Fri" (display only).
 */
function dayText(days: string[]) {
  if (days.length === 7) return "Every day";
  return days.map((d) => DAY_NAMES[d] ?? d).join(", ");
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string | string[] }>;
}) {
  const me = await requireRole("manager");
  const { id } = await params;
  const pricing = getPricing();
  const t = await loadTariff(pricing, me, id);
  if (!t || !t.definition) notFound();
  const created = (await searchParams).created;
  const def = t.definition;
  // Only asked when the editor has no grace period of its own to show.
  const graceDefault = def.idleMinorPerMinute
    ? def.idleGraceMinutes
    : await idleGraceDefault(pricing, me, def);
  return (
    <>
      <CrumbName path={`/pricing/${t.id}`} label={t.name} />
      <PageHeader
        title={t.name}
        description={`${t.summary || "Not live yet"}${t.current ? ` · version ${t.current.version}` : ""}`}
      />
      {created === "1" && !t.pending && (
        <p className="success" role="status">
          Tariff created in Ivora. Assign it to chargers on the{" "}
          <Link href="/pricing">Pricing</Link> page.
          {me.demo && " Demo: nothing was sent to Ivora."}
        </p>
      )}
      {t.needsFinishing && (
        <section className="card notice" aria-labelledby="finish-heading">
          <h2 id="finish-heading">Not confirmed by Ivora yet</h2>
          <p>
            {t.pending
              ? `Version ${t.pending.version} is saved in the kit, but Ivora has not confirmed it (the answer was lost or Ivora was busy). ${t.current ? `Drivers keep version ${t.current.version} until then.` : "It can't be assigned until then."}`
              : "An older version is still active in Ivora. Bills made with the kit already use the newest version."}{" "}
            Finish saving first asks Ivora whether it has the version, and only
            sends it again if not, so nothing is created twice.
            {t.pending &&
              " Or discard this draft: drivers keep the current version (the kit archives anything Ivora made for the draft)."}
          </p>
          <FinishTariff tariffId={t.id} canDiscard={Boolean(t.pending)} />
        </section>
      )}
      <section className="card" aria-labelledby="now-heading">
        <h2 id="now-heading">
          {t.current ? `Version ${t.current.version}` : "Not live yet"}
          {me.demo && <span className="badge">Sample</span>}
        </h2>
        <dl className="facts">
          <div>
            <dt>Type</dt>
            <dd>{tariffType(def)}</dd>
          </div>
          <div>
            <dt>Prices</dt>
            <dd>{t.summary}</dd>
          </div>
          {t.driverText && (
            <div>
              <dt>Drivers read</dt>
              <dd>{t.driverText}</dd>
            </div>
          )}
          <div>
            <dt>Card hold before charging</dt>
            <dd>
              {holdMinor(def)
                ? formatMinor(holdMinor(def), def.currency)
                : "None (free)"}
            </dd>
          </div>
          {t.current?.ivoraTariffId && (
            <div>
              <dt>Ivora tariff</dt>
              <dd>{t.current.ivoraTariffId}</dd>
            </div>
          )}
        </dl>
        {def.periods.length > 0 && (
          <>
            <h3>Time-of-use periods</h3>
            <p className="muted">
              Local times in {def.timeZone}. Outside these periods the price is{" "}
              {formatMinor(def.energyMinorPerKwh, def.currency)} per kWh.
            </p>
            <div
              className="table-scroll-area"
              tabIndex={0}
              role="region"
              aria-label="Time-of-use periods"
            >
              <table className="grid-table">
                <caption className="visually-hidden">
                  Time-of-use periods
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Days</th>
                    <th scope="col">From</th>
                    <th scope="col">To</th>
                    <th scope="col" className="num">
                      Per kWh
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {def.periods.map((p, i) => (
                    <tr key={i}>
                      <td data-label="Days">{dayText(p.days)}</td>
                      <td data-label="From">{p.start}</td>
                      <td data-label="To">{p.end}</td>
                      <td data-label="Per kWh" className="num">
                        {formatMinor(p.energyMinorPerKwh, def.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
      <section className="card" aria-labelledby="editor-heading">
        <h2 id="editor-heading">Change prices</h2>
        <p className="muted">
          Saving creates version{" "}
          {(t.pending?.version ?? t.current?.version ?? 0) + 1} as a new Ivora
          tariff. Past and open bills keep the price they were made with.
        </p>
        <TariffEditor
          tariffId={t.id}
          revision={t.revision}
          initial={editorValues(t.name, def, def, graceDefault)}
          currency={def.currency}
          timeZones={TIME_ZONES}
          simulation={defaultSimulation(def.timeZone)}
          locked={Boolean(t.pending)}
          paidNote={paidCurrencyNote(def.currency, me.demo)}
        />
      </section>
      <section className="card" aria-labelledby="versions-heading">
        <h2 id="versions-heading">Versions</h2>
        <ul className="rows" aria-label="Versions">
          {t.versions.map((v) => (
            <li key={v.version}>
              <span className="name">Version {v.version}</span>
              <span className="muted">
                {v.ivoraTariffId ? `Ivora tariff ${v.ivoraTariffId}` : ""}
              </span>
              <When iso={v.createdAt} zone={def.timeZone} />
              <StatusChip
                tone={v === t.pending ? "busy" : v === t.current ? "ok" : "off"}
              >
                {v === t.pending
                  ? "Waiting for Ivora"
                  : v === t.current
                    ? "In use"
                    : v.archivedAt
                      ? "Replaced (archived in Ivora)"
                      : "Replaced"}
              </StatusChip>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
