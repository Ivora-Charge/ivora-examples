import "server-only";
import { randomUUID } from "node:crypto";
import { toE4 } from "@/lib/locations/pricing";
import type { Cdr, Session } from "@/lib/ocpi/session-objects";
import {
  eq,
  supabaseRest,
  type SupabaseTransport,
} from "@/lib/server/supabase-rest";
import type {
  CdrKey,
  CdrSource,
  NewCdr,
  ReconciliationQuery,
  ReconciliationRow,
  SessionKey,
  SessionStore,
  SessionWrite,
  StoredCdr,
  StoredSession,
} from "./store";

type SessionRow = {
  id: string;
  peer_id: string;
  data: Session;
  field_times: Record<string, string>;
  driver_ref: string | null;
  command_id: string | null;
  completed_at: string | null;
  revision: string;
  created_at: string;
  updated_at: string;
};

type CdrRow = {
  id: string;
  peer_id: string;
  data: Cdr;
  driver_ref: string | null;
  command_id: string | null;
  source: CdrSource;
  received_at: string;
};

type ReconciliationDbRow = {
  peer_id: string;
  day: string;
  currency: string;
  sessions: number;
  sessions_open: number;
  sessions_completed: number;
  sessions_invalid: number;
  session_kwh_e4: number;
  sessions_without_cdr: number;
  sessions_without_cdr_ids: string[];
  cdrs: number;
  credit_cdrs: number;
  cdrs_without_session: number;
  cdrs_without_session_ids: string[];
  cdr_energy_e4: number;
  cdr_cost_excl_vat_e4: number;
  cdr_cost_incl_vat_e4: number | null;
};

/** Postgres returns `+00:00`; the rest of the server works with `Z` ISO strings. */
const iso = (v: string) => new Date(v).toISOString();
const isoOrNull = (v: string | null) => (v === null ? null : iso(v));
const e4 = (n: number) => Number(toE4(n));

const session = (r: SessionRow): StoredSession => ({
  id: r.id,
  peerId: r.peer_id,
  session: r.data,
  fieldTimes: r.field_times,
  driverRef: r.driver_ref,
  commandId: r.command_id,
  completedAt: isoOrNull(r.completed_at),
  revision: r.revision,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const cdr = (r: CdrRow): StoredCdr => ({
  id: r.id,
  peerId: r.peer_id,
  cdr: r.data,
  driverRef: r.driver_ref,
  commandId: r.command_id,
  source: r.source,
  receivedAt: iso(r.received_at),
});

/** The columns of a session write: the object, and what queries filter on. */
const sessionColumns = (w: SessionWrite) => ({
  data: w.session,
  field_times: w.fieldTimes,
  status: w.session.status,
  start_date_time: w.session.start_date_time,
  end_date_time: w.session.end_date_time ?? null,
  kwh_e4: e4(w.session.kwh),
  currency: w.session.currency,
  last_updated: w.session.last_updated,
  driver_ref: w.driverRef,
  command_id: w.commandId,
  completed_at: w.completedAt,
});

const sessionFilter = (k: SessionKey) =>
  `peer_id=${eq(k.peerId)}&country_code=${eq(k.countryCode.toUpperCase())}&party_id=${eq(k.partyId.toUpperCase())}&session_id=${eq(k.sessionId)}`;

/**
 * Sessions and CDRs in Supabase Postgres (emsp_sessions, emsp_cdrs), through the Data
 * API as the service role. A session write is a compare-and-swap on its revision; a
 * CDR is inserted once and the database refuses any change to it.
 */
export class SupabaseSessionStore implements SessionStore {
  private readonly rest: ReturnType<typeof supabaseRest>;

  constructor(
    url: string,
    serviceRoleKey: string,
    transport?: SupabaseTransport,
  ) {
    this.rest = supabaseRest(url, serviceRoleKey, transport);
  }

  private async sessions(filter: string): Promise<StoredSession[]> {
    const rows = await this.rest<SessionRow[]>(
      "GET",
      `emsp_sessions?${filter}&select=*`,
    );
    return rows.map(session);
  }

  async getSession(key: SessionKey) {
    return (await this.sessions(sessionFilter(key)))[0] ?? null;
  }

  async getSessionById(id: string) {
    return (await this.sessions(`id=${eq(id)}`))[0] ?? null;
  }

  findSessions(peerId: string, sessionId: string) {
    return this.sessions(
      `peer_id=${eq(peerId)}&session_id=${eq(sessionId)}&order=created_at.asc`,
    );
  }

  async insertSession(peerId: string, w: SessionWrite, now: string) {
    const [row] = await this.rest<SessionRow[]>(
      "POST",
      "emsp_sessions?on_conflict=peer_id,country_code,party_id,session_id&select=*",
      {
        peer_id: peerId,
        country_code: w.session.country_code,
        party_id: w.session.party_id,
        session_id: w.session.id,
        ...sessionColumns(w),
        created_at: now,
        updated_at: now,
      },
      "resolution=ignore-duplicates,return=representation",
    );
    return row ? session(row) : null;
  }

  async updateSession(
    id: string,
    expectedRevision: string,
    w: SessionWrite,
    now: string,
  ) {
    const [row] = await this.rest<SessionRow[]>(
      "PATCH",
      `emsp_sessions?id=${eq(id)}&revision=${eq(expectedRevision)}&select=*`,
      { ...sessionColumns(w), revision: randomUUID(), updated_at: now },
      "return=representation",
    );
    return row ? session(row) : null;
  }

  private async cdrs(filter: string): Promise<StoredCdr[]> {
    const rows = await this.rest<CdrRow[]>(
      "GET",
      `emsp_cdrs?${filter}&select=*`,
    );
    return rows.map(cdr);
  }

  async getCdr(k: CdrKey) {
    return (
      (
        await this.cdrs(
          `peer_id=${eq(k.peerId)}&country_code=${eq(k.countryCode.toUpperCase())}&party_id=${eq(k.partyId.toUpperCase())}&cdr_id=${eq(k.cdrId)}`,
        )
      )[0] ?? null
    );
  }

  async getCdrById(id: string) {
    return (await this.cdrs(`id=${eq(id)}`))[0] ?? null;
  }

  async insertCdr(peerId: string, c: NewCdr, now: string) {
    const d = c.cdr;
    const [row] = await this.rest<CdrRow[]>(
      "POST",
      "emsp_cdrs?on_conflict=peer_id,country_code,party_id,cdr_id&select=*",
      {
        peer_id: peerId,
        country_code: d.country_code,
        party_id: d.party_id,
        cdr_id: d.id,
        session_id: d.session_id ?? null,
        data: d,
        start_date_time: d.start_date_time,
        end_date_time: d.end_date_time,
        currency: d.currency,
        total_energy_e4: e4(d.total_energy),
        total_cost_excl_vat_e4: e4(d.total_cost.excl_vat),
        total_cost_incl_vat_e4:
          d.total_cost.incl_vat === undefined
            ? null
            : e4(d.total_cost.incl_vat),
        credit: d.credit ?? false,
        credit_reference_id: d.credit_reference_id ?? null,
        last_updated: d.last_updated,
        driver_ref: c.driverRef,
        command_id: c.commandId,
        source: c.source,
        received_at: now,
      },
      "resolution=ignore-duplicates,return=representation",
    );
    return row ? cdr(row) : null;
  }

  async hasCdr(k: SessionKey) {
    const rows = await this.rest<{ id: string }[]>(
      "GET",
      `emsp_cdrs?peer_id=${eq(k.peerId)}&country_code=${eq(k.countryCode.toUpperCase())}&party_id=${eq(k.partyId.toUpperCase())}&session_id=${eq(k.sessionId)}&credit=is.false&select=id&limit=1`,
    );
    return rows.length > 0;
  }

  async reconcile(q: ReconciliationQuery): Promise<ReconciliationRow[]> {
    const rows = await this.rest<ReconciliationDbRow[]>(
      "POST",
      "rpc/emsp_reconciliation",
      { p_from: q.from, p_to: q.to, p_peer_id: q.peerId ?? null },
    );
    return rows.map((r) => ({
      peerId: r.peer_id,
      day: r.day.slice(0, 10),
      currency: r.currency,
      sessions: r.sessions,
      sessionsOpen: r.sessions_open,
      sessionsCompleted: r.sessions_completed,
      sessionsInvalid: r.sessions_invalid,
      sessionKwhE4: Number(r.session_kwh_e4),
      sessionsWithoutCdr: r.sessions_without_cdr,
      sessionsWithoutCdrIds: r.sessions_without_cdr_ids,
      cdrs: r.cdrs,
      creditCdrs: r.credit_cdrs,
      cdrsWithoutSession: r.cdrs_without_session,
      cdrsWithoutSessionIds: r.cdrs_without_session_ids,
      cdrEnergyE4: Number(r.cdr_energy_e4),
      cdrCostExclVatE4: Number(r.cdr_cost_excl_vat_e4),
      cdrCostInclVatE4:
        r.cdr_cost_incl_vat_e4 === null ? null : Number(r.cdr_cost_incl_vat_e4),
    }));
  }
}
