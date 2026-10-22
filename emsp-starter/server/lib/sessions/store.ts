import "server-only";
import { randomUUID } from "node:crypto";
import { toE4 } from "@/lib/locations/pricing";
import { dateTimeMs } from "@/lib/ocpi/locations";
import type { Cdr, Session } from "@/lib/ocpi/session-objects";

/**
 * Our drivers' sessions and CDRs, per CPO peer, keyed like OCPI: the CPO party's country
 * code and party ID, and its session or CDR ID. Two CPOs that use the same IDs never
 * meet.
 *
 * - A session is the CPO's latest version with every change applied, written with
 *   compare-and-swap on its `revision`. It is never deleted.
 * - A CDR is kept exactly as it first arrived: never changed, never deleted.
 * - Both carry their links: the driver (by the START_SESSION command or by the token)
 *   and the command.
 */
export type SessionKey = {
  peerId: string;
  countryCode: string;
  partyId: string;
  sessionId: string;
};

export type CdrKey = {
  peerId: string;
  countryCode: string;
  partyId: string;
  cdrId: string;
};

export type Links = {
  /** The driver, by the start command or the token. Null for a token we did not issue. */
  driverRef: string | null;
  /** The START_SESSION command it came from, by authorization_reference. */
  commandId: string | null;
};

export type SessionWrite = Links & {
  session: Session;
  /**
   * When each field of `session` was last set, by the CPO's last_updated: a change
   * older than a field's time leaves that field alone (record.ts).
   */
  fieldTimes: Record<string, string>;
  /** When it ended for us; set once, with the session.completed event. */
  completedAt: string | null;
};

export type StoredSession = SessionWrite & {
  /** Ours. */
  id: string;
  peerId: string;
  /** Changes with every write: the compare-and-swap token for updateSession. */
  revision: string;
  createdAt: string;
  updatedAt: string;
};

export type CdrSource = "push" | "pull";

export type NewCdr = Links & { cdr: Cdr; source: CdrSource };

export type StoredCdr = NewCdr & {
  /** Ours: the last segment of the URL we give the CPO for it. */
  id: string;
  peerId: string;
  receivedAt: string;
};

/** E4: ten-thousandths of the unit (kWh, or the currency's major unit), whole numbers. */
export type ReconciliationRow = {
  peerId: string;
  /** UTC day the sessions and CDRs started, YYYY-MM-DD. */
  day: string;
  currency: string;
  sessions: number;
  /** ACTIVE, PENDING or RESERVATION. */
  sessionsOpen: number;
  sessionsCompleted: number;
  sessionsInvalid: number;
  /** kWh of the sessions that are not INVALID, as the sessions say. */
  sessionKwhE4: number;
  /** COMPLETED sessions that no CDR names (a credit CDR does not count). */
  sessionsWithoutCdr: number;
  /** `country_code/party_id/session_id`, at most RECONCILIATION_ID_LIMIT. */
  sessionsWithoutCdrIds: string[];
  /** CDRs that are not credit CDRs. */
  cdrs: number;
  creditCdrs: number;
  /** CDRs (not credit CDRs) that name no session we hold, or none at all. */
  cdrsWithoutSession: number;
  /** `country_code/party_id/cdr_id`, at most RECONCILIATION_ID_LIMIT. */
  cdrsWithoutSessionIds: string[];
  /** CDRs (credit CDRs too) of a token we did not issue: no driver of ours to bill. */
  cdrsUnknownToken: number;
  /** `country_code/party_id/cdr_id`, at most RECONCILIATION_ID_LIMIT. */
  cdrsUnknownTokenIds: string[];
  /** CDRs (credit CDRs too) in another currency than the session they name. */
  cdrsCurrencyMismatch: number;
  /** `country_code/party_id/cdr_id`, at most RECONCILIATION_ID_LIMIT. */
  cdrsCurrencyMismatchIds: string[];
  /** Net of credit CDRs, which count negative. */
  cdrEnergyE4: number;
  cdrCostExclVatE4: number;
  /** Null when a CDR of the group gave no amount including VAT. */
  cdrCostInclVatE4: number | null;
};

export const RECONCILIATION_ID_LIMIT = 100;

export type ReconciliationQuery = {
  /** Inclusive. */
  from: string;
  /** Exclusive. */
  to: string;
  peerId?: string;
};

export interface SessionStore {
  getSession(key: SessionKey): Promise<StoredSession | null>;
  getSessionById(id: string): Promise<StoredSession | null>;
  /** The sessions with this ID at this peer, of any of its parties. */
  findSessions(peerId: string, sessionId: string): Promise<StoredSession[]>;
  /** Null when the session exists already (another write got there first). */
  insertSession(
    peerId: string,
    write: SessionWrite,
    now: string,
  ): Promise<StoredSession | null>;
  /** Only while its revision is still `expectedRevision`; null otherwise. */
  updateSession(
    id: string,
    expectedRevision: string,
    write: SessionWrite,
    now: string,
  ): Promise<StoredSession | null>;
  getCdr(key: CdrKey): Promise<StoredCdr | null>;
  getCdrById(id: string): Promise<StoredCdr | null>;
  /** Null when the CDR exists already: the first one stays. */
  insertCdr(
    peerId: string,
    cdr: NewCdr,
    now: string,
  ): Promise<StoredCdr | null>;
  /** True when a CDR (not a credit CDR) names this session. */
  hasCdr(key: SessionKey): Promise<boolean>;
  reconcile(query: ReconciliationQuery): Promise<ReconciliationRow[]>;
}

const e4 = (n: number) => Number(toE4(n));
const utcDay = (dateTime: string) =>
  new Date(dateTimeMs(dateTime)).toISOString().slice(0, 10);
const inRange = (dateTime: string, q: ReconciliationQuery) => {
  const t = dateTimeMs(dateTime);
  return t >= Date.parse(q.from) && t < Date.parse(q.to);
};
const OPEN = ["ACTIVE", "PENDING", "RESERVATION"];
/** Byte order, like the database's `collate "C"`. */
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Sessions and CDRs in memory: for demo mode (nothing persists) and for tests. */
export class MemorySessionStore implements SessionStore {
  readonly sessions = new Map<string, StoredSession>();
  readonly cdrs = new Map<string, StoredCdr>();

  private sessionKey = (k: SessionKey) =>
    JSON.stringify([
      k.peerId,
      k.countryCode.toUpperCase(),
      k.partyId.toUpperCase(),
      k.sessionId,
    ]);
  private cdrKey = (k: CdrKey) =>
    JSON.stringify([
      k.peerId,
      k.countryCode.toUpperCase(),
      k.partyId.toUpperCase(),
      k.cdrId,
    ]);
  private ofSession = (peerId: string, s: Session) =>
    this.sessionKey({
      peerId,
      countryCode: s.country_code,
      partyId: s.party_id,
      sessionId: s.id,
    });

  async getSession(key: SessionKey) {
    const s = this.sessions.get(this.sessionKey(key));
    return s ? structuredClone(s) : null;
  }

  async getSessionById(id: string) {
    for (const s of this.sessions.values())
      if (s.id === id) return structuredClone(s);
    return null;
  }

  async findSessions(peerId: string, sessionId: string) {
    return [...this.sessions.values()]
      .filter((s) => s.peerId === peerId && s.session.id === sessionId)
      .map((s) => structuredClone(s));
  }

  // No awaits before the writes: each check and write is one step, like a database row.
  async insertSession(peerId: string, write: SessionWrite, now: string) {
    const key = this.ofSession(peerId, write.session);
    if (this.sessions.has(key)) return null;
    const stored: StoredSession = {
      ...structuredClone(write),
      id: randomUUID(),
      peerId,
      revision: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(key, stored);
    return structuredClone(stored);
  }

  async updateSession(
    id: string,
    expectedRevision: string,
    write: SessionWrite,
    now: string,
  ) {
    for (const [key, s] of this.sessions)
      if (s.id === id) {
        if (s.revision !== expectedRevision) return null;
        const next: StoredSession = {
          ...s,
          ...structuredClone(write),
          revision: randomUUID(),
          updatedAt: now,
        };
        this.sessions.set(key, next);
        return structuredClone(next);
      }
    return null;
  }

  async getCdr(key: CdrKey) {
    const c = this.cdrs.get(this.cdrKey(key));
    return c ? structuredClone(c) : null;
  }

  async getCdrById(id: string) {
    for (const c of this.cdrs.values())
      if (c.id === id) return structuredClone(c);
    return null;
  }

  async insertCdr(peerId: string, cdr: NewCdr, now: string) {
    const key = this.cdrKey({
      peerId,
      countryCode: cdr.cdr.country_code,
      partyId: cdr.cdr.party_id,
      cdrId: cdr.cdr.id,
    });
    if (this.cdrs.has(key)) return null;
    const stored: StoredCdr = {
      ...structuredClone(cdr),
      id: randomUUID(),
      peerId,
      receivedAt: now,
    };
    this.cdrs.set(key, stored);
    return structuredClone(stored);
  }

  async hasCdr(key: SessionKey) {
    return [...this.cdrs.values()].some(
      (c) =>
        c.peerId === key.peerId &&
        !c.cdr.credit &&
        c.cdr.country_code === key.countryCode.toUpperCase() &&
        c.cdr.party_id === key.partyId.toUpperCase() &&
        c.cdr.session_id === key.sessionId,
    );
  }

  /** The same figures as the database function emsp_reconciliation. */
  async reconcile(q: ReconciliationQuery): Promise<ReconciliationRow[]> {
    const rows = new Map<string, ReconciliationRow>();
    const row = (peerId: string, day: string, currency: string) => {
      const key = JSON.stringify([peerId, day, currency]);
      let r = rows.get(key);
      if (!r)
        rows.set(
          key,
          (r = {
            peerId,
            day,
            currency,
            sessions: 0,
            sessionsOpen: 0,
            sessionsCompleted: 0,
            sessionsInvalid: 0,
            sessionKwhE4: 0,
            sessionsWithoutCdr: 0,
            sessionsWithoutCdrIds: [],
            cdrs: 0,
            creditCdrs: 0,
            cdrsWithoutSession: 0,
            cdrsWithoutSessionIds: [],
            cdrsUnknownToken: 0,
            cdrsUnknownTokenIds: [],
            cdrsCurrencyMismatch: 0,
            cdrsCurrencyMismatchIds: [],
            cdrEnergyE4: 0,
            cdrCostExclVatE4: 0,
            cdrCostInclVatE4: 0,
          }),
        );
      return r;
    };
    const wanted = (peerId: string, start: string) =>
      (!q.peerId || peerId === q.peerId) && inRange(start, q);

    for (const { peerId, session: s } of this.sessions.values()) {
      if (!wanted(peerId, s.start_date_time)) continue;
      const r = row(peerId, utcDay(s.start_date_time), s.currency);
      r.sessions++;
      if (OPEN.includes(s.status)) r.sessionsOpen++;
      if (s.status === "COMPLETED") r.sessionsCompleted++;
      if (s.status === "INVALID") r.sessionsInvalid++;
      else r.sessionKwhE4 += e4(s.kwh);
      const key = {
        peerId,
        countryCode: s.country_code,
        partyId: s.party_id,
        sessionId: s.id,
      };
      if (s.status === "COMPLETED" && !(await this.hasCdr(key))) {
        r.sessionsWithoutCdr++;
        r.sessionsWithoutCdrIds.push(`${s.country_code}/${s.party_id}/${s.id}`);
      }
    }

    for (const { peerId, cdr: c, driverRef } of this.cdrs.values()) {
      if (!wanted(peerId, c.start_date_time)) continue;
      const r = row(peerId, utcDay(c.start_date_time), c.currency);
      const sign = (n: number) => (c.credit ? -Math.abs(n) : n);
      const ref = `${c.country_code}/${c.party_id}/${c.id}`;
      const session = c.session_id
        ? await this.getSession({
            peerId,
            countryCode: c.country_code,
            partyId: c.party_id,
            sessionId: c.session_id,
          })
        : null;
      if (driverRef === null) {
        r.cdrsUnknownToken++;
        r.cdrsUnknownTokenIds.push(ref);
      }
      if (session && session.session.currency !== c.currency) {
        r.cdrsCurrencyMismatch++;
        r.cdrsCurrencyMismatchIds.push(ref);
      }
      if (c.credit) r.creditCdrs++;
      else {
        r.cdrs++;
        if (!session) {
          r.cdrsWithoutSession++;
          r.cdrsWithoutSessionIds.push(ref);
        }
      }
      r.cdrEnergyE4 += sign(e4(c.total_energy));
      r.cdrCostExclVatE4 += sign(e4(c.total_cost.excl_vat));
      r.cdrCostInclVatE4 =
        r.cdrCostInclVatE4 === null || c.total_cost.incl_vat === undefined
          ? null
          : r.cdrCostInclVatE4 + sign(e4(c.total_cost.incl_vat));
    }

    return [...rows.values()]
      .map((r) => ({
        ...r,
        sessionsWithoutCdrIds: r.sessionsWithoutCdrIds
          .sort(byCode)
          .slice(0, RECONCILIATION_ID_LIMIT),
        cdrsWithoutSessionIds: r.cdrsWithoutSessionIds
          .sort(byCode)
          .slice(0, RECONCILIATION_ID_LIMIT),
        cdrsUnknownTokenIds: r.cdrsUnknownTokenIds
          .sort(byCode)
          .slice(0, RECONCILIATION_ID_LIMIT),
        cdrsCurrencyMismatchIds: r.cdrsCurrencyMismatchIds
          .sort(byCode)
          .slice(0, RECONCILIATION_ID_LIMIT),
      }))
      .sort(
        (a, b) =>
          byCode(a.peerId, b.peerId) ||
          byCode(a.day, b.day) ||
          byCode(a.currency, b.currency),
      );
  }
}
