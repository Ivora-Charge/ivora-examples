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
import { holdMinor } from "@/lib/server/pricing/tariff";
import { FinishTariff, TariffEditor } from "../forms";
import { Loading } from "@/app/loading-skeleton";

export const metadata = { title: "Tariff" };

const when = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(Date.parse(iso)) + " UTC";

async function Content({
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
      <p>
        <Link href="/pricing">← Pricing</Link>
      </p>
      <h1>{t.name}</h1>
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
        />
      </section>
      <section className="card" aria-labelledby="versions-heading">
        <h2 id="versions-heading">Versions</h2>
        <ul className="rows" aria-label="Versions">
          {t.versions.map((v) => (
            <li key={v.version}>
              <span className="name">Version {v.version}</span>
              <span className="muted">
                {[
                  when(v.createdAt),
                  v.ivoraTariffId ? `Ivora tariff ${v.ivoraTariffId}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <span className={v === t.current ? "pill ok" : "pill off"}>
                {v === t.pending
                  ? "Waiting for Ivora"
                  : v === t.current
                    ? "In use"
                    : v.archivedAt
                      ? "Replaced (archived in Ivora)"
                      : "Replaced"}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

/** The page behind its loading skeleton. */
export default function Page(props: Parameters<typeof Content>[0]) {
  return (
    <Loading shape="detail">
      <Content {...props} />
    </Loading>
  );
}
