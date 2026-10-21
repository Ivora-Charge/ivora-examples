import type { Call } from "./fake-api";
import { fakeFetch } from "./fake-api";

/**
 * A station behind a fake Ivora API that keeps what the charger really applies,
 * so tests can check the site cap against the station rather than the app's own
 * bookkeeping. Answers can be made to fail in the ways the API documents.
 */

export type Answer =
  | "accept" // the charger answers Accepted at once
  | "pending" // the charger applies it, the answer comes later by webhook
  | "pending-later" // the charger applies it only when the answer arrives
  | "reject" // the charger answers Rejected
  | "offline" // 409 station_offline, nothing sent
  | "offline-rejected" // 202, operation rejected with station_offline, nothing sent
  | "unknown-applied" // 503 outcome_unknown, but it was applied
  | "unknown-lost" // 503 outcome_unknown, nothing happened
  | "unsupported"; // 409 smart_charging_unsupported, nothing sent

export interface StationProfile {
  id: string;
  purpose: string;
  station: number;
  /** Undefined for a baseline (tx_default) profile. */
  tx?: number;
  stack: number;
  startAt: number;
  periods: { start_offset_seconds: number; limit: number }[];
  state: "pending" | "accepted" | "rejected" | "cleared" | "replaced" | "ended";
  /** The charger is applying it. */
  installed: boolean;
  /** Why it was rejected, as GET /charging-profiles/{id} reports it. */
  error?: { code: string; message: string };
}

interface Reply {
  status?: number;
  json?: unknown;
}

export function fakeStation(opts: {
  protocol: "ocpp1.6" | "ocpp2.0.1";
  answer?: (c: Call) => Answer;
  /** Called before every request, with the profiles as they were. */
  beforeRequest?: (c: Call) => void;
  /** Called after every request, with the profiles as they are now. */
  onChange?: (c: Call) => void;
  /** Stations served by GET /stations/{id}: connector ID and rating (W, or null). */
  stations?: Record<number, { id: number; maxW: number | null }[]>;
  /** False makes GET /stations/{id} fail (503). */
  stationLookup?: (station: number) => boolean;
}) {
  const profiles: StationProfile[] = [];
  /** Transactions started with startTx(): what governs them before their own profile. */
  const txs = new Map<number, { station: number; startW: number }>();
  const replies = new Map<string, Reply>();
  /**
   * Charger answers the app has not heard yet. `applied`: the charger has already
   * acted on it (it handles commands in order, so it has once a later one arrives).
   */
  const outbox: { id: string; accepted: boolean; applied: boolean }[] = [];
  let n = 0;
  const answer = (c: Call) => opts.answer?.(c) ?? "accept";
  const unknown: Reply = {
    status: 503,
    json: { error: { code: "outcome_unknown", message: "?" }, request_id: "r" },
  };
  const offline: Reply = {
    status: 409,
    json: { error: { code: "station_offline", message: "offline" } },
  };
  const unsupported: Reply = {
    status: 409,
    json: {
      error: {
        code: "smart_charging_unsupported",
        message: "no smart charging",
      },
    },
  };
  const ratingW = (station: number, connectorId: number) => {
    const conns = opts.stations?.[station] ?? [];
    const w = (x: { maxW: number | null }) => x.maxW ?? 11000;
    const c = conns.find((x) => x.id === connectorId);
    return c ? w(c) : Math.max(0, ...conns.map(w));
  };

  const highest = (p: StationProfile) =>
    Math.max(...p.periods.map((x) => x.limit));
  /** Sent, not acted on by the charger yet: it may still be applied. */
  const inFlight = (p: StationProfile) => !p.installed && p.state === "pending";

  function install(p: StationProfile) {
    if (opts.protocol === "ocpp1.6")
      for (const x of profiles)
        if (
          x !== p &&
          x.purpose === p.purpose &&
          x.station === p.station &&
          x.tx === p.tx &&
          x.stack === p.stack &&
          x.installed
        ) {
          x.installed = false;
          x.state = "replaced";
        }
    p.installed = true;
  }

  /** The charger acts on earlier commands before a new one. */
  function catchUp() {
    for (const m of outbox) if (!m.applied) apply(m);
  }

  function apply(m: (typeof outbox)[number]) {
    m.applied = true;
    const p = profiles.find((x) => x.id === m.id)!;
    if (p.state !== "pending") return;
    p.state = m.accepted ? "accepted" : "rejected";
    if (m.accepted) install(p);
  }

  function setProfile(c: Call, a: Answer): Reply {
    catchUp();
    const body = JSON.parse(c.body!);
    const station = Number(c.url.match(/\/stations\/(\d+)\//)?.[1]);
    const live = profiles.filter(
      (x) =>
        x.purpose === body.purpose &&
        x.station === station &&
        x.tx === body.transaction_id &&
        x.stack === body.stack_level &&
        (x.state === "pending" || x.state === "accepted"),
    );
    if (opts.protocol !== "ocpp1.6" && live.length > 0)
      return {
        status: 422,
        json: {
          error: {
            code: "charging_profile_refused",
            message: "a profile at this purpose, EVSE and stack level exists",
          },
        },
      };
    const p: StationProfile = {
      id: `chp_${++n}`,
      purpose: body.purpose,
      station,
      tx: body.transaction_id,
      stack: body.stack_level,
      startAt: Date.parse(body.start_at ?? "1970-01-01T00:00:00Z"),
      periods: body.periods,
      state: "pending",
      installed: false,
    };
    profiles.push(p);
    let charger: string | null = null;
    if (a === "accept" || a === "unknown-applied") {
      p.state = "accepted";
      install(p);
      charger = "Accepted";
    } else if (a === "reject") {
      p.state = "rejected";
      charger = "Rejected";
    } else if (a === "pending") {
      install(p);
      outbox.push({ id: p.id, accepted: true, applied: true });
    } else outbox.push({ id: p.id, accepted: true, applied: false });
    return {
      status: 202,
      json: {
        id: `op_${p.id}`,
        status: "succeeded",
        result: { profile_id: p.id, charger_status: charger },
      },
    };
  }

  function clearProfile(id: string): Reply {
    catchUp();
    const p = profiles.find((x) => x.id === id);
    if (!p || (p.state !== "pending" && p.state !== "accepted"))
      return {
        status: 409,
        json: { error: { code: "charging_profile_inactive", message: id } },
      };
    p.state = "cleared";
    p.installed = false;
    return {
      status: 202,
      json: { id: `op_clear_${id}`, status: "succeeded", result: {} },
    };
  }

  const api = fakeFetch((c) => {
    opts.beforeRequest?.(c);
    const reply = route(c);
    opts.onChange?.(c);
    return reply;
  });

  function route(c: Call): Reply {
    const path = c.url.replace(/^https:\/\/[^/]+\/v1\/tenants\/\d+/, "");
    const key = c.headers["idempotency-key"];
    if (key && replies.has(key)) return replies.get(key)!;
    if (c.method === "POST" && /\/charging-profiles$/.test(path)) {
      const a = answer(c);
      if (a === "offline") return offline;
      if (a === "offline-rejected") {
        const r: Reply = {
          status: 202,
          json: {
            id: `op_offline_${++n}`,
            status: "rejected",
            result: {
              error: { code: "station_offline", message: "station offline" },
            },
          },
        };
        if (key) replies.set(key, r);
        return r;
      }
      if (a === "unsupported") return unsupported;
      if (a === "unknown-lost") return unknown;
      const r = setProfile(c, a);
      if (key && r.status !== 422) replies.set(key, r);
      return a === "unknown-applied" ? unknown : r;
    }
    const del = path.match(/\/charging-profiles\/([^/]+)$/);
    if (c.method === "DELETE" && del) {
      const a = answer(c);
      if (a === "offline" || a === "offline-rejected" || a === "unsupported")
        return offline;
      if (a === "unknown-lost") return unknown;
      const r = clearProfile(decodeURIComponent(del[1]));
      if (key) replies.set(key, r);
      return a === "unknown-applied" ? unknown : r;
    }
    if (c.method === "GET" && del) {
      const p = profiles.find((x) => x.id === decodeURIComponent(del[1]));
      return p
        ? {
            json: {
              id: p.id,
              status: p.state,
              stack_level: p.stack,
              error: p.error ?? null,
            },
          }
        : { status: 404, json: { error: { code: "not_found", message: "" } } };
    }
    const st = path.match(/^\/stations\/(\d+)$/);
    if (c.method === "GET" && st && opts.stations?.[Number(st[1])]) {
      const id = Number(st[1]);
      if (opts.stationLookup && !opts.stationLookup(id)) return unknown;
      return {
        json: {
          id,
          name: `station-${id}`,
          protocol: opts.protocol,
          connectors: opts.stations[id].map((x, i) => ({
            id: x.id,
            number: i + 1,
            max_power_w: x.maxW,
          })),
        },
      };
    }
    if (c.method === "POST" && /\/composite-schedule$/.test(path))
      return {
        status: 202,
        json: {
          id: "op_c",
          status: "succeeded",
          result: { schedule: { unit: "W", periods: [] } },
        },
      };
    return {
      status: 404,
      json: { error: { code: "not_found", message: path } },
    };
  }

  return {
    fetch: api.fetch,
    calls: api.calls,
    profiles,
    outbox,
    /** The charger answers a pending profile (what a charging_profile.* webhook reports). */
    deliver(i = 0) {
      const [m] = outbox.splice(i, 1);
      const p = profiles.find((x) => x.id === m.id)!;
      if (!m.applied) apply(m);
      else if (p.state === "pending") p.state = "accepted";
      return m;
    },
    /**
     * What a new transaction on this station may draw before its own session profile
     * is in force: the installed tx_default profile of the highest stack level.
     */
    baselineW(station: number): number | undefined {
      const base = profiles.filter(
        (p) =>
          p.purpose === "tx_default" && p.station === station && p.installed,
      );
      if (base.length === 0) return undefined;
      return base.reduce((a, b) => (b.stack >= a.stack ? b : a)).periods[0]
        .limit;
    },
    /**
     * A vehicle plugs in: the charger applies the tx_default profile in force now to
     * this transaction (OCPP: for new transactions), or its own default, the
     * connector rating, when there is none.
     */
    startTx(tx: number, station: number, connectorId: number) {
      txs.set(tx, {
        station,
        startW: Math.min(
          this.baselineW(station) ?? Infinity,
          ratingW(station, connectorId),
        ),
      });
    },
    /** The session ended: the charger drops its session profiles. */
    endTx(tx: number) {
      txs.delete(tx);
      for (const p of profiles)
        if (p.tx === tx) {
          p.installed = false;
          if (p.state === "pending" || p.state === "accepted")
            p.state = "ended";
        }
    },
    /** What a vehicle plugging into this connector now may draw, W. */
    idleW(station: number, connectorId: number) {
      return Math.min(
        this.baselineW(station) ?? Infinity,
        ratingW(station, connectorId),
      );
    },
    /**
     * What the charger lets this transaction draw at `at`, W: the installed profile
     * with the highest stack level (the latest at equal levels). Without one, what
     * governed it at startTx(); for a transaction not started that way, the current
     * baseline (undefined when there is none: the charger's own default).
     */
    limitW(tx: number, at: number, station = 12): number | undefined {
      return (
        this.ownLimitW(tx, at) ?? txs.get(tx)?.startW ?? this.baselineW(station)
      );
    },
    /**
     * The most this transaction may draw now or once the answers in flight land, W:
     * its own installed profile (else what governed it at startTx(), when `covered`),
     * and any of its profiles the charger has not acted on yet. Highest period.
     */
    worstTxW(tx: number, covered: boolean): number {
      const mine = profiles.filter((p) => p.tx === tx);
      const installed = mine.filter((p) => p.installed);
      const now = installed.length
        ? highest(installed.reduce((a, b) => (b.stack >= a.stack ? b : a)))
        : covered
          ? (txs.get(tx)?.startW ?? 0)
          : 0;
      return Math.max(now, ...mine.filter(inFlight).map(highest));
    },
    /** The baseline in force or in flight at this station, W; undefined when there is none. */
    worstBaselineW(station: number): number | undefined {
      const mine = profiles.filter(
        (p) => p.purpose === "tx_default" && p.station === station,
      );
      const w = [
        this.baselineW(station),
        ...mine.filter(inFlight).map(highest),
      ];
      const known = w.filter((x) => x !== undefined);
      return known.length ? Math.max(...known) : undefined;
    },
    /** What a vehicle plugging into this idle connector may draw, in flight included, W. */
    worstIdleW(station: number, connectorId: number) {
      return Math.min(
        this.worstBaselineW(station) ?? Infinity,
        ratingW(station, connectorId),
      );
    },
    /** The transaction's own installed profile at `at`, W; undefined when it has none. */
    ownLimitW(tx: number, at: number): number | undefined {
      const mine = profiles.filter((p) => p.tx === tx && p.installed);
      if (mine.length === 0) return undefined;
      const top = mine.reduce((a, b) => (b.stack >= a.stack ? b : a));
      const offset = (at - top.startAt) / 1000;
      let limit = top.periods[0].limit;
      for (const p of top.periods)
        if (p.start_offset_seconds <= offset) limit = p.limit;
      return limit;
    },
  };
}
