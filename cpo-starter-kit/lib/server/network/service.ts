import "server-only";
import { formatMinor } from "@/lib/money";
import { isHostId } from "@/lib/hosts";
import {
  FEE_LIMITS,
  parseFeeAmount,
  parsePercent,
  validTerms,
  type FeeMode,
  type FeeTerms,
} from "@/lib/network-fee";
import { atLeast, HOST_ROLE } from "@/lib/roles";
import {
  buildStatement,
  statementRow,
  type Statement,
  type StatementSession,
} from "@/lib/statement";
import type { HostRecord, HostStore } from "../hosts/types";
import type { IvoraClient } from "../ivora";
import { localDate, zonedToUtc } from "../pricing/time";
import { reportStatus } from "../reports/records";
import { reportTimeZone } from "../reports/service";
import type { ReportCheckout } from "../reports/types";
import type { Staff } from "../team/types";
import { planAt } from "./demo";
import {
  NetworkError,
  type FeePlan,
  type NetworkStore,
  type PayoutAccount,
  type PayoutStatus,
} from "./types";

// Network fee, payout status and statements, shared by demo and live mode. Every read
// checks who is asking here, on the server: operator staff see every host; a host user
// only their own host, and anything else answers "not found". Writes check the role
// again in the database, in the same statement as the write.

export interface NetworkDeps {
  store: NetworkStore;
  hosts: Pick<HostStore, "list" | "sites">;
  ivora: Pick<IvoraClient, "mode" | "listAllStations" | "listAllLocations">;
  company: {
    load(
      operatorId: string,
    ): Promise<{ timeZone: string | null; currency: string | null }>;
  };
  now?: () => number;
}

/**
 * Whether card payments at a host's site can go to the host's own account in this
 * mode. Demo: simulated (nothing is sent anywhere). Live: not yet. The direct charge
 * on the host's connected account is designed (README: Host payouts) and waits for
 * review, so a live paid checkout at a host's site is refused rather than
 * paid into the operator's own account.
 */
export function hostPaymentsAvailable(mode: "live" | "demo"): boolean {
  return mode === "demo";
}

export const PAYOUT_LABELS: Record<PayoutStatus, string> = {
  none: "Not connected",
  action_needed: "Action needed",
  ready: "Ready",
};

const notFound = () =>
  new NetworkError(
    "not_found",
    "That host is not in the kit any more. Reload the page.",
  );

// ---- Fee versions ----

/** The fee form: mode, percent, per-kWh amount and monthly fee, in `currency`. */
export function parseFeeTerms(
  raw: Record<string, unknown>,
  currency: string,
): FeeTerms {
  const text = (k: string) =>
    typeof raw[k] === "string" ? (raw[k] as string) : "";
  const mode = text("mode") as FeeMode;
  if (mode !== "percent" && mode !== "per_kwh")
    throw new NetworkError("invalid", "Choose how the fee is worked out.");
  const percentBps =
    mode === "percent" ? parsePercent(text("percent") || "0") : 0;
  if (percentBps === null)
    throw new NetworkError(
      "invalid",
      "Enter the fee as a percentage from 0 to 100, with at most 2 decimals (for example 7.5).",
    );
  const perKwhMinor =
    mode === "per_kwh"
      ? parseFeeAmount(text("perKwh"), currency, FEE_LIMITS.perKwhMinor)
      : 0;
  if (perKwhMinor === null)
    throw new NetworkError(
      "invalid",
      `Enter the fee per kWh in ${currency}, for example 0.05, up to ${formatMinor(FEE_LIMITS.perKwhMinor, currency)}.`,
    );
  const monthly = parseFeeAmount(
    text("monthly"),
    currency,
    FEE_LIMITS.monthlyChargerFeeMinor,
  );
  if (monthly === null)
    throw new NetworkError(
      "invalid",
      `Enter the monthly fee per charger in ${currency}, or leave it empty, up to ${formatMinor(FEE_LIMITS.monthlyChargerFeeMinor, currency)}.`,
    );
  const terms: FeeTerms = {
    mode,
    percentBps,
    perKwhMinor,
    monthlyChargerFeeMinor: monthly,
    currency,
  };
  if (!validTerms(terms))
    throw new NetworkError("invalid", "Check the fee and try again.");
  return terms;
}

async function activeHost(
  d: NetworkDeps,
  operatorId: string,
  hostId: unknown,
): Promise<HostRecord> {
  if (!isHostId(hostId)) throw notFound();
  const h = (await d.hosts.list(operatorId)).find(
    (x) => x.id === hostId && !x.archivedAt,
  );
  if (!h) throw notFound();
  return h;
}

/** The company currency: what fee amounts are typed in. USD when none is set. */
async function companyCurrency(d: NetworkDeps, operatorId: string) {
  const p = await d.company.load(operatorId).catch(() => null);
  return p?.currency && /^[A-Z]{3}$/.test(p.currency) ? p.currency : "USD";
}

/** Saves a new fee version for a host, effective now. Owners and managers only. */
export async function saveFeePlan(
  d: NetworkDeps,
  actor: Staff,
  hostId: unknown,
  raw: Record<string, unknown>,
): Promise<FeePlan> {
  if (actor.role === HOST_ROLE || !atLeast(actor.role, "manager"))
    throw new NetworkError(
      "not_allowed",
      "Only owners and managers set a host's network fee.",
    );
  const h = await activeHost(d, actor.operatorId, hostId);
  const terms = parseFeeTerms(raw, await companyCurrency(d, actor.operatorId));
  const plan = await d.store.setFeePlan(actor, h.id, terms);
  console.info("cpo-starter-kit: host fee saved", {
    host: h.id,
    plan: plan.id,
  });
  return plan;
}

export interface HostMoney {
  /** The fee in effect now, and every earlier version (newest first). */
  current: FeePlan | null;
  history: FeePlan[];
  payout: PayoutAccount;
}

/** The Hosts page: each host's fee versions and payout status. Owners and managers. */
export async function loadHostMoney(
  d: NetworkDeps,
  actor: Staff,
): Promise<{
  byHost: Map<string, HostMoney>;
  currency: string;
  live: boolean;
}> {
  if (actor.role === HOST_ROLE || !atLeast(actor.role, "manager"))
    throw new NetworkError("not_allowed", "Owners and managers only.");
  const [plans, payouts, hosts, currency] = await Promise.all([
    d.store.feePlans(actor.operatorId),
    d.store.payouts(actor.operatorId),
    d.hosts.list(actor.operatorId),
    companyCurrency(d, actor.operatorId),
  ]);
  const t = (d.now ?? Date.now)();
  const byHost = new Map<string, HostMoney>();
  for (const h of hosts) {
    const mine = plans
      .filter((p) => p.hostId === h.id)
      .sort(
        (a, b) => Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom),
      );
    byHost.set(h.id, {
      current: planAt(mine, h.id, t),
      history: mine,
      payout: payouts.find((p) => p.hostId === h.id) ?? {
        hostId: h.id,
        status: "none",
        accountId: null,
        requirements: [],
        checkedAt: null,
      },
    });
  }
  return { byHost, currency, live: d.ivora.mode === "live" };
}

// ---- Driver checkout: is the site's host ready to be paid? ----

export type PayoutGate =
  | { ok: true; hostId: string | null }
  | { ok: false; hostId: string; reason: PayoutStatus | "live_unavailable" };

/**
 * May a paid checkout at `locationId` go ahead? A site with no host: yes, as before
 * (the operator's own account). A host's site: only while the host's payout account is
 * ready, and only where host payments are available (demo; see hostPaymentsAvailable).
 * Read on the server from the kit's database with the service role (the driver is not
 * signed in), never from the browser.
 */
export async function payoutGate(
  d: Pick<NetworkDeps, "store">,
  mode: "live" | "demo",
  operatorId: string,
  locationId: number | null | undefined,
): Promise<PayoutGate> {
  if (typeof locationId !== "number") return { ok: true, hostId: null };
  const site = await d.store.siteHost(operatorId, locationId);
  if (!site) return { ok: true, hostId: null };
  if (site.status !== "ready")
    return { ok: false, hostId: site.hostId, reason: site.status };
  if (!hostPaymentsAvailable(mode))
    return { ok: false, hostId: site.hostId, reason: "live_unavailable" };
  return { ok: true, hostId: site.hostId };
}

/** What staff read about a host whose sites can't take card payments. */
export function payoutGateMessage(reason: PayoutStatus | "live_unavailable") {
  switch (reason) {
    case "none":
      return "This host has not connected a payout account, so driver card payments at its sites are off. Connect it on the Hosts page.";
    case "action_needed":
      return "Stripe needs more details from this host before it can take payments, so driver card payments at its sites are off. See the Hosts page.";
    case "live_unavailable":
      return "Card payments to a host's own account are not available in live mode yet, so driver card payments at this host's sites are off (README: Host payouts).";
    case "ready":
      return "";
  }
}

// ---- Session rows: the amount, the network fee and the host's share ----

export interface RowFee {
  hostId: string;
  hostName: string;
  /**
   * The network fee after refunds and the host's share (captured − refunds − fee), as
   * the host's statement shows them; null while unsettled, or while a per-kWh fee waits
   * for the session's energy.
   */
  feeMinor: number | null;
  hostShareMinor: number | null;
  note: string | null;
}

/** A checkout as a statement session (the fee terms recorded at its start). */
export function statementSession(
  c: ReportCheckout,
  terms: FeeTerms | null,
  names: { chargerName: string; siteName: string | null },
): StatementSession {
  return {
    reference: c.reference,
    kind: c.kind,
    status: reportStatus(c),
    createdAt: c.createdAt,
    startedAt: c.sessionStartedAt,
    endedAt: c.sessionEndedAt,
    siteName: names.siteName,
    chargerName: names.chargerName,
    energyWh: c.detailAt ? c.energyWh : null,
    currency: c.currency,
    capturedMinor: c.capturedMinor,
    refundedMinor: c.refundedMinor,
    terms,
  };
}

/**
 * For a Reports page's rows: each row at a host's site, with the host, the network fee
 * and the host's share, worked out exactly as on the host's statement. Rows at no
 * host's site are absent. The caller has already limited the rows to what `staff` may
 * see; a host user gets fees of their own host's sessions only.
 */
export async function rowFees(
  d: Pick<NetworkDeps, "store" | "hosts">,
  staff: Staff,
  rows: ReportCheckout[],
): Promise<Map<string, RowFee>> {
  const out = new Map<string, RowFee>();
  if (!rows.length) return out;
  const [snaps, hosts] = await Promise.all([
    d.store.checkoutHosts(staff.operatorId, rows),
    staff.role === HOST_ROLE
      ? Promise.resolve(
          staff.host
            ? [{ id: staff.host.id, name: staff.host.name }]
            : ([] as { id: string; name: string }[]),
        )
      : d.hosts.list(staff.operatorId),
  ]);
  const names = new Map(hosts.map((h) => [h.id, h.name]));
  for (const c of rows) {
    const s = snaps.get(c.id);
    if (!s) continue;
    if (staff.role === HOST_ROLE && s.hostId !== staff.host?.id) continue;
    const r = statementRow(
      statementSession(c, s.terms, { chargerName: "", siteName: null }),
    );
    const money = r.kind === "revenue" || r.kind === "no_charge";
    out.set(c.id, {
      hostId: s.hostId,
      hostName: names.get(s.hostId) ?? "Archived host",
      feeMinor: money ? r.netFeeMinor : null,
      hostShareMinor: money ? r.hostShareMinor : null,
      note: r.note,
    });
  }
  return out;
}

// ---- Monthly statements ----

/** "2026-10": a month, or null. */
export function parseMonth(v: unknown): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  if (typeof s !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  return y >= 2000 && y <= 2100 ? s : null;
}

export function shiftMonth(month: string, by: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + by;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}`;
}

/** The month as [from, to) instants in `zone`. */
export function monthRange(month: string, zone: string) {
  return {
    fromMs: zonedToUtc(`${month}-01`, "00:00", zone).getTime(),
    toMs: zonedToUtc(`${shiftMonth(month, 1)}-01`, "00:00", zone).getTime(),
  };
}

/** Rows a statement reads at most; more is refused rather than cut silently. */
export const STATEMENT_MAX_ROWS = 5_000;

export interface StatementView {
  host: { id: string; name: string };
  month: string;
  timeZone: string;
  fromMs: number;
  toMs: number;
  statement: Statement;
  /** The fee terms in effect at the month's end (its charger fee line). */
  monthTerms: FeeTerms | null;
  chargers: number;
  payout: PayoutStatus;
  mode: "live" | "demo";
}

/**
 * Who may read a host's statement: operator staff (viewers and above), and the host's
 * own users. Anyone else, and any other host, is "not found".
 */
export async function statementHost(
  d: Pick<NetworkDeps, "hosts">,
  staff: Staff,
  rawHostId: unknown,
): Promise<{ id: string; name: string }> {
  if (staff.role === HOST_ROLE) {
    const own = staff.host;
    if (
      !own ||
      (rawHostId !== undefined &&
        rawHostId !== null &&
        rawHostId !== "" &&
        rawHostId !== own.id)
    )
      throw notFound();
    return { id: own.id, name: own.name };
  }
  if (!atLeast(staff.role, "viewer")) throw notFound();
  const h = (await d.hosts.list(staff.operatorId)).find(
    (x) => x.id === rawHostId,
  );
  if (!h || !isHostId(rawHostId)) throw notFound();
  return { id: h.id, name: h.name };
}

/** A host's statement for one month (the current month by default). */
export async function loadStatement(
  d: NetworkDeps,
  staff: Staff,
  rawHostId: unknown,
  rawMonth: unknown,
): Promise<StatementView> {
  const host = await statementHost(d, staff, rawHostId);
  const [profile, stations, locations, sites, plans, payouts] =
    await Promise.all([
      d.company.load(staff.operatorId).catch(() => null),
      d.ivora.listAllStations(),
      d.ivora.listAllLocations(),
      d.hosts.sites(staff.operatorId),
      d.store.feePlans(staff.operatorId),
      d.store.payouts(staff.operatorId),
    ]);
  const zone = reportTimeZone(profile?.timeZone ?? null, locations.data).zone;
  const now = (d.now ?? Date.now)();
  const month = parseMonth(rawMonth) ?? localDate(zone, now).slice(0, 7);
  const { fromMs, toMs } = monthRange(month, zone);
  const rows = await d.store.hostCheckouts(
    staff.operatorId,
    host.id,
    fromMs,
    toMs,
    STATEMENT_MAX_ROWS + 1,
  );
  if (rows.length > STATEMENT_MAX_ROWS)
    throw new NetworkError(
      "invalid",
      `This month has more than ${STATEMENT_MAX_ROWS.toLocaleString("en-US")} sessions for one host: download it from Reports with the host filter instead.`,
    );
  const siteIds = new Set(
    sites.filter((s) => s.hostId === host.id).map((s) => s.locationId),
  );
  const hostStations = stations.data.filter(
    (s) => typeof s.location_id === "number" && siteIds.has(s.location_id),
  );
  const siteNames = new Map(locations.data.map((l) => [l.id, l.name]));
  const byStation = new Map(stations.data.map((s) => [s.id, s]));
  const sessions: StatementSession[] = rows.map(({ checkout: c, terms }) => {
    const st = byStation.get(c.stationId);
    return statementSession(c, terms, {
      chargerName: st?.name ?? `Charger ${c.stationId}`,
      siteName:
        st && typeof st.location_id === "number"
          ? (siteNames.get(st.location_id) ?? null)
          : null,
    });
  });
  // The charger fee line uses the terms in effect at the month's end (or now, for the
  // current month), and the chargers at the host's sites now.
  const monthTerms =
    planAt(plans, host.id, Math.min(toMs - 1, now))?.terms ?? null;
  return {
    host,
    month,
    timeZone: zone,
    fromMs,
    toMs,
    statement: buildStatement(sessions, monthTerms, hostStations.length),
    monthTerms,
    chargers: hostStations.length,
    payout: payouts.find((p) => p.hostId === host.id)?.status ?? "none",
    mode: d.ivora.mode,
  };
}

/** The statement's file name: statement-<host>-<month>.csv, safe characters only. */
export function statementFileName(v: Pick<StatementView, "host" | "month">) {
  const name = v.host.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `statement-${name || "host"}-${v.month}.csv`;
}
