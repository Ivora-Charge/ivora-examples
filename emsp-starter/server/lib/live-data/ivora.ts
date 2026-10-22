import "server-only";
import { readLimitedText } from "@/lib/ocpi/body";
import { PeerAddressError, peerFetch } from "@/lib/server/peer-fetch";
import {
  LiveDataError,
  type LiveData,
  type LiveDataAdapter,
  type LiveSessionRef,
} from "./adapter";

/**
 * A live-data adapter for CPO peers that run on Ivora, through the public Ivora API
 * (https://api.ivoracharge.com/openapi.json) with a read-only key of that CPO's
 * project (scope `billing:read`, nothing else).
 *
 * Mapping, by public fields only: on Ivora an OCPI session's ID is the charging
 * transaction's resource ID, so the adapter reads `GET /v1/tenants/{tenant}/transactions/{id}`
 * and uses it only when it matches the session: not a test transaction, started within
 * 10 minutes of the session's start_date_time, and, when Ivora shows the masked ID
 * token, its last characters are the session token's. Anything else returns `{}`:
 * a guess could show another driver's car.
 *
 * Then `GET …/transactions/{id}/meter-values` gives the samples the charger reported,
 * newest last: the last `SoC` and the last total `Power.Active.Import`. A charger that
 * reports no SoC gives no SoC.
 *
 * Read-only by construction: the one request function sends GET to these two paths and
 * nothing else. Requests go through `peerFetch` (https, public addresses only, refused
 * in demo mode), time out after 5 seconds and read at most 1 MB. The key goes only in
 * the Authorization header; errors and logs never include it.
 *
 * Failures are not retried on every poll. A 429 pauses every call of this adapter (so of
 * this peer) until its Retry-After has passed; a 401 or 403 (a revoked key) and a URL
 * that is not a public address pause it for 10 minutes; any other failure is answered
 * from the cache for 30 seconds per session. Saving new settings builds a new adapter,
 * which starts afresh.
 */
export type IvoraSettings = {
  /** The API origin, for example https://api.ivoracharge.com. */
  baseUrl: string;
  /** The CPO's numeric tenant ID (its project), from `GET /v1/access`. */
  tenantId: string;
  /** A read-only API key of that tenant. Secret. */
  apiKey: string;
};

export type IvoraDeps = {
  /** Sends one GET. Defaults to peerFetch; tests pass an HTTP mock. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
};

/** How far apart the session's and the transaction's start may be. */
export const START_TOLERANCE_MS = 10 * 60 * 1000;
/** A reading is reused for this long, so an app polling every few seconds costs one call. */
export const CACHE_MS = 15_000;
/** Any other failure is remembered per session for this long. */
export const ERROR_CACHE_MS = 30_000;
/** A 429 without a usable Retry-After pauses the adapter this long. */
export const RATE_LIMIT_MS = 60_000;
/** A Retry-After is honoured up to this long. */
export const MAX_RETRY_AFTER_MS = 15 * 60 * 1000;
/** A rejected key, or an API URL that is not public, pauses the adapter this long. */
export const BLOCKED_MS = 10 * 60 * 1000;
const PAGE_SIZE = 500;
/** Pages read per call; the cursor is kept, so a long session catches up over calls. */
const MAX_PAGES = 10;
const MAX_TRANSACTIONS = 1000;
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 5000;

export const IVORA_KEY_PATTERN = /^[\x21-\x7e]{16,512}$/;

type Reading = { value: number; at?: string };

type MeterState = {
  /** The last meter value ID read: the next page starts after it. */
  after: number;
  soc?: Reading;
  power?: Reading;
};

type Transaction = {
  id?: unknown;
  test?: unknown;
  active?: unknown;
  started_at?: unknown;
  ended_at?: unknown;
  id_token?: unknown;
};

type Sample = {
  measurand?: unknown;
  value?: unknown;
  unit?: unknown;
  multiplier?: unknown;
  phase?: unknown;
};

type MeterRecord = { id?: unknown; timestamp?: unknown; samples?: unknown };

/** A sample's value in its unit, multiplier applied; undefined when it is not a number. */
function sampleValue(s: Sample): number | undefined {
  if (typeof s.value !== "string" || !/^-?\d+(\.\d+)?$/.test(s.value.trim()))
    return undefined;
  const m = Number.isInteger(s.multiplier) ? (s.multiplier as number) : 0;
  const v = Number(s.value) * 10 ** m;
  return Number.isFinite(v) ? v : undefined;
}

/** The SoC in percent. Ivora fills an omitted unit with Wh, OCPP's default. */
function socOf(s: Sample): number | undefined {
  if (s.measurand !== "SoC") return undefined;
  if (s.unit !== "Percent" && s.unit !== "Wh") return undefined;
  return sampleValue(s);
}

/** The total power to the vehicle in kW; per-phase samples are not added up. */
function powerKwOf(s: Sample): number | undefined {
  if (s.measurand !== "Power.Active.Import" || s.phase) return undefined;
  const v = sampleValue(s);
  if (v === undefined) return undefined;
  if (s.unit === "W") return v / 1000;
  if (s.unit === "kW") return v;
  return undefined;
}

/** True when Ivora's transaction is this session's. */
export function transactionMatches(
  tx: Transaction,
  ref: LiveSessionRef,
): boolean {
  if (tx.test === true) return false;
  if (String(tx.id) !== ref.sessionId) return false;
  if (typeof tx.started_at !== "string") return false;
  const started = Date.parse(tx.started_at);
  const expected = Date.parse(ref.startDateTime);
  if (!Number.isFinite(started) || !Number.isFinite(expected)) return false;
  if (Math.abs(started - expected) > START_TOLERANCE_MS) return false;
  // Masked as ****ABCD: the token's last characters must agree.
  if (typeof tx.id_token === "string" && tx.id_token) {
    const tail = /^\**([^*]+)$/.exec(tx.id_token)?.[1];
    if (!tail || !ref.tokenUid.toUpperCase().endsWith(tail.toUpperCase()))
      return false;
  }
  return true;
}

/** Retry-After in milliseconds from `now`: delta-seconds or an HTTP date. */
export function retryAfterMs(
  header: string | null,
  now: number,
): number | undefined {
  const v = header?.trim();
  if (!v) return undefined;
  if (/^\d{1,9}$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? at - now : undefined;
}

function checkSettings(s: IvoraSettings): string {
  let url: URL;
  try {
    url = new URL(s.baseUrl);
  } catch {
    throw new LiveDataError("ivora_settings", "Ivora API URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new LiveDataError("ivora_settings", "Ivora API URL must be https://");
  if (!/^\d{1,18}$/.test(s.tenantId))
    throw new LiveDataError(
      "ivora_settings",
      "Ivora tenant ID must be numeric",
    );
  if (!IVORA_KEY_PATTERN.test(s.apiKey))
    throw new LiveDataError("ivora_settings", "Ivora API key is invalid");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function ivoraAdapter(
  settings: IvoraSettings,
  deps: IvoraDeps = {},
): LiveDataAdapter {
  const base = checkSettings(settings);
  const tenant = `${base}/v1/tenants/${settings.tenantId}`;
  const send = deps.fetch ?? peerFetch;
  const now = deps.now ?? Date.now;
  const host = new URL(base).host;
  const meters = new Map<string, MeterState>();
  const recent = new Map<
    string,
    { at: number; live: LiveData } | { at: number; error: LiveDataError }
  >();
  /** Set while every call is paused: after a 429, a rejected key or a refused address. */
  let paused: { until: number; code: string } | undefined;

  function pause(code: string, ms: number) {
    const until = now() + ms;
    if (!paused || paused.until < until) paused = { until, code };
  }

  function remember(key: string, entry: Parameters<typeof recent.set>[1]) {
    if (recent.size >= MAX_TRANSACTIONS && !recent.has(key))
      recent.delete(recent.keys().next().value!);
    recent.set(key, entry);
  }

  /** The one request this adapter makes: a GET. Null on 404. */
  async function get<T>(path: string, signal?: AbortSignal): Promise<T | null> {
    if (paused && now() < paused.until)
      throw new LiveDataError(
        paused.code,
        "Ivora API calls paused after an earlier failure",
      );
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    let res: Response;
    try {
      res = await send(`${tenant}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          Accept: "application/json",
        },
        redirect: "manual",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code === "demo_mode") throw e;
      if (e instanceof PeerAddressError) {
        // The URL leads to this server's own network: an SSRF attempt or a wrong setting.
        pause("ivora_address_refused", BLOCKED_MS);
        console.warn(
          `Live data: refused to call the Ivora API at ${host} for its address (SSRF protection); paused for ${BLOCKED_MS / 60_000} minutes`,
        );
        throw new LiveDataError(
          "ivora_address_refused",
          "Ivora API URL is not a public https address",
        );
      }
      throw new LiveDataError("ivora_unreachable", "Ivora API unreachable");
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      let code = `ivora_http_${res.status}`;
      if (res.status === 401 || res.status === 403) {
        code = "ivora_unauthorized";
        pause(code, BLOCKED_MS);
      } else if (res.status === 429) {
        code = "ivora_rate_limited";
        const wait = retryAfterMs(res.headers.get("retry-after"), now());
        pause(
          code,
          wait === undefined
            ? RATE_LIMIT_MS
            : Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, wait)),
        );
      }
      throw new LiveDataError(code, `Ivora API answered HTTP ${res.status}`);
    }
    try {
      return JSON.parse(await readLimitedText(res, MAX_BYTES)) as T;
    } catch {
      throw new LiveDataError("ivora_invalid", "Ivora API answer unreadable");
    }
  }

  /** Reads the meter values after the cursor, keeping the newest SoC and power. */
  async function readMeters(
    txId: string,
    state: MeterState,
    signal?: AbortSignal,
  ) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const list = await get<{ data?: unknown; next_cursor?: unknown }>(
        `/transactions/${txId}/meter-values?after=${state.after}&limit=${PAGE_SIZE}`,
        signal,
      );
      const data = Array.isArray(list?.data)
        ? (list.data as MeterRecord[])
        : [];
      for (const record of data) {
        if (typeof record.id === "number" && record.id > state.after)
          state.after = record.id;
        const at =
          typeof record.timestamp === "string" ? record.timestamp : undefined;
        for (const s of Array.isArray(record.samples)
          ? (record.samples as Sample[])
          : []) {
          const soc = socOf(s);
          if (soc !== undefined) state.soc = { value: soc, at };
          const power = powerKwOf(s);
          if (power !== undefined) state.power = { value: power, at };
        }
      }
      const next = list?.next_cursor;
      if (typeof next === "number" && next > state.after) state.after = next;
      if (data.length < PAGE_SIZE) return;
    }
  }

  async function read(
    key: string,
    ref: LiveSessionRef,
    signal?: AbortSignal,
  ): Promise<LiveData> {
    const tx = await get<Transaction>(`/transactions/${ref.sessionId}`, signal);
    if (!tx || !transactionMatches(tx, ref)) {
      if (tx)
        console.warn(
          `Live data: Ivora transaction ${ref.sessionId} does not match the session of peer ${ref.peerId}; nothing shown`,
        );
      return {};
    }

    // Kept before reading, so a long first read cut off by a timeout still keeps the
    // pages it got: each page moves the cursor once it is read whole.
    const state = meters.get(key) ?? { after: 0 };
    if (!meters.has(key)) {
      if (meters.size >= MAX_TRANSACTIONS)
        meters.delete(meters.keys().next().value!);
      meters.set(key, state);
    }
    await readMeters(ref.sessionId, state, signal);

    const ended = tx.active === false || typeof tx.ended_at === "string";
    const live: LiveData = {};
    // Each value keeps its own time, so a fresh SoC never vouches for an old power.
    if (state.soc?.at) {
      live.socPercent = state.soc.value;
      live.socMeasuredAt = state.soc.at;
    }
    // A finished transaction draws nothing, whatever its last sample said.
    if (state.power?.at && !ended) {
      live.powerKw = state.power.value;
      live.powerMeasuredAt = state.power.at;
    }
    return live;
  }

  return {
    kind: "ivora",
    async getLive(ref, signal) {
      // Ivora's OCPI session IDs are transaction IDs: anything else is not one of its.
      if (!/^\d{1,18}$/.test(ref.sessionId)) return {};
      const key = `${ref.countryCode}/${ref.partyId}/${ref.sessionId}`;
      const hit = recent.get(key);
      if (hit && "error" in hit && now() - hit.at < ERROR_CACHE_MS)
        throw hit.error;
      if (hit && "live" in hit && now() - hit.at < CACHE_MS) return hit.live;
      try {
        const live = await read(key, ref, signal);
        remember(key, { at: now(), live });
        return live;
      } catch (e) {
        if (e instanceof LiveDataError) remember(key, { at: now(), error: e });
        throw e;
      }
    },
  };
}
