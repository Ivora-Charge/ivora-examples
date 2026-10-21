import "server-only";
import { isDemo } from "../env";
import { IvoraError } from "./errors";
import type {
  IvoraClient,
  Listed,
  ListOptions,
  Location,
  LocationInput,
  Page,
  Station,
  Transaction,
} from "./types";

export interface LiveOptions {
  baseUrl: string;
  apiKey: string;
  tenantId: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Total tries per request, first one included (default 4). */
  attempts?: number;
}

/**
 * Longest total time one call may spend waiting between retries (Retry-After and
 * backoff together), so a request stays well inside a serverless function's time
 * limit. A wait that would go past it is returned to the caller instead.
 */
export const MAX_TOTAL_WAIT_SECONDS = 20;
/** Pages followed by the listAll* methods (100 records each). */
export const MAX_LIST_PAGES = 20;
const TIMEOUT_MS = 15_000;
const KEY = /^[\x21-\x7e]{8,128}$/;

/** Codes after which the same request is repeated with the same Idempotency-Key. */
const RETRY_SAME_KEY = new Set(["request_in_progress", "outcome_unknown"]);
/** A create that may already have happened: look the record up by our reference. */
const ADOPT_BY_REFERENCE = new Set([
  "external_reference_taken",
  "request_in_progress",
  "outcome_unknown",
]);

/**
 * Seconds from a Retry-After header: delta-seconds or an HTTP date. Null when absent
 * or unreadable.
 */
export function parseRetryAfter(
  value: string | null,
  now = Date.now(),
): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

function retriable(e: IvoraError): boolean {
  if (e.status === 429) return true;
  if (RETRY_SAME_KEY.has(e.code)) return true;
  // Lost connection or timeout (the request may have arrived), or a gateway error.
  return (
    e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504
  );
}

async function toError(res: Response): Promise<IvoraError> {
  const j = (await res.json().catch(() => null)) as {
    error?: { code?: unknown; message?: unknown };
    request_id?: unknown;
  } | null;
  const code =
    typeof j?.error?.code === "string"
      ? j.error.code
      : res.status === 429
        ? "rate_limited"
        : `http_${res.status}`;
  const message =
    typeof j?.error?.message === "string"
      ? j.error.message
      : `Request failed (HTTP ${res.status})`;
  return new IvoraError(
    res.status,
    code,
    message,
    typeof j?.request_id === "string" ? j.request_id : undefined,
    parseRetryAfter(res.headers.get("retry-after")) ?? undefined,
  );
}

/** The Ivora API client for this deployment's credentials. Server-side only. */
export function createLiveClient(o: LiveOptions): IvoraClient {
  if (!o.apiKey) throw new Error("IVORA_API_KEY is missing");
  if (!/^\d+$/.test(o.tenantId))
    throw new Error("IVORA_TENANT_ID must be the numeric tenant ID");
  const base = new URL(o.baseUrl);
  if (base.protocol !== "https:" && base.hostname !== "localhost")
    throw new Error("IVORA_API_BASE_URL must use https://");
  const origin = base.origin;
  const doFetch: typeof fetch = (...a) => (o.fetch ?? globalThis.fetch)(...a);
  const sleep =
    o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const attempts = o.attempts ?? 4;

  async function once<T>(
    method: string,
    path: string,
    body: unknown,
    key: string | undefined,
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${o.apiKey}`,
      accept: "application/json",
    };
    if (key) headers["idempotency-key"] = key;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await doFetch(`${origin}/v1/tenants/${o.tenantId}/${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new IvoraError(0, "network_error", "Could not reach the Ivora API");
    }
    if (!res.ok) throw await toError(res);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  /**
   * One API call. Writes need an Idempotency-Key derived from our record and action;
   * every retry (409 request_in_progress, 503 outcome_unknown, 429, lost response)
   * sends that same key and body, so the action happens at most once. All waits share
   * one budget (MAX_TOTAL_WAIT_SECONDS), which a multi-page list passes along.
   */
  async function request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    opts: { body?: unknown; key?: string; budget?: { waitedS: number } } = {},
  ): Promise<T> {
    const budget = opts.budget ?? { waitedS: 0 };
    // Second guard behind getIvora(): a live client never sends in demo mode.
    if (isDemo()) throw new Error("Demo mode never calls the Ivora API");
    if (method !== "GET" && !(opts.key && KEY.test(opts.key)))
      throw new Error(`Idempotency-Key missing or invalid for ${method}`);
    for (let n = 1; ; n++) {
      try {
        return await once<T>(method, path, opts.body, opts.key);
      } catch (e) {
        if (!(e instanceof IvoraError) || !retriable(e) || n >= attempts)
          throw e;
        const waitS = e.retryAfterSeconds ?? 2 ** (n - 1);
        // Past the budget: hand the error (and its Retry-After) back to the caller.
        if (budget.waitedS + waitS > MAX_TOTAL_WAIT_SECONDS) throw e;
        budget.waitedS += waitS;
        await sleep(waitS * 1000);
      }
    }
  }

  const query = (o: Record<string, string | number | boolean | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o))
      if (v !== undefined) p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : "";
  };
  const list = (o: ListOptions = {}) =>
    query({ limit: o.limit ?? 100, external_reference: o.external_reference });

  /** Follows `next_cursor` page by page, up to MAX_LIST_PAGES. */
  async function listAll<T>(path: string): Promise<Listed<T>> {
    const data: T[] = [];
    const budget = { waitedS: 0 };
    let after = 0;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const res = await request<Page<T>>(
        "GET",
        `${path}${query({ limit: 100, after: after || undefined })}`,
        { budget },
      );
      data.push(...res.data);
      const next = res.next_cursor;
      // Stop on the last page, and on a cursor that does not move forward.
      if (!next || !res.data.length || next <= after)
        return { data, truncated: false };
      after = next;
    }
    return { data, truncated: true };
  }

  return {
    mode: "live",
    async listLocations(o) {
      return (await request<Page<Location>>("GET", `locations${list(o)}`)).data;
    },
    async createLocation(input: LocationInput, key: string) {
      try {
        return await request<Location>("POST", "locations", {
          body: input,
          key,
        });
      } catch (e) {
        if (!(e instanceof IvoraError) || !ADOPT_BY_REFERENCE.has(e.code))
          throw e;
        const [found] = await this.listLocations({
          external_reference: input.external_reference,
          limit: 1,
        });
        if (found) return found;
        throw e;
      }
    },
    listAllLocations() {
      return listAll<Location>("locations");
    },
    listAllStations() {
      return listAll<Station>("stations");
    },
    async listStations(o) {
      return (await request<Page<Station>>("GET", `stations${list(o)}`)).data;
    },
    getStation(stationId: number) {
      return request<Station>("GET", `stations/${stationId}`);
    },
    async listTransactions(o = {}) {
      return (
        await request<Page<Transaction>>(
          "GET",
          `transactions${query({ limit: o.limit ?? 50, station_id: o.station_id })}`,
        )
      ).data;
    },
  };
}
