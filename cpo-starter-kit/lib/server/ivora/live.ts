import "server-only";
import { isDemo } from "../env";
import { IvoraError } from "./errors";
import type {
  Bill,
  Branding,
  Fault,
  IvoraClient,
  Listed,
  ListOptions,
  Location,
  LocationInput,
  Operation,
  Page,
  Payment,
  PaymentAccount,
  Quote,
  Station,
  StationInput,
  Tariff,
  TariffArchived,
  TokenRecord,
  Transaction,
} from "./types";

export interface LiveOptions {
  baseUrl: string;
  apiKey: string;
  tenantId: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds clock, for tests. */
  now?: () => number;
  /** Total tries per request, first one included (default 4). */
  attempts?: number;
}

/**
 * Longest total time one call may take: every try and every wait between tries
 * (Retry-After and backoff) together, so a request stays well inside a serverless
 * function's time limit. A wait or try that would go past it is not started; the last
 * error (with its Retry-After) goes back to the caller instead. The listAll* methods
 * share one such deadline across their pages.
 */
export const MAX_REQUEST_SECONDS = 20;
/** Pages followed by the listAll* methods (100 records each). */
export const MAX_LIST_PAGES = 20;
/** Longest single try. */
const TIMEOUT_MS = 10_000;
/** A try with less time left than this is not worth starting. */
const MIN_TRY_MS = 1_000;
const KEY = /^[\x21-\x7e]{8,128}$/;

/** A request body: JSON text or raw image bytes, with its content type. */
interface Body {
  data: string | Uint8Array<ArrayBuffer>;
  contentType: string;
}

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

/**
 * Answers that ask for a new key or a person: password_unconfirmed means Ivora could
 * not confirm a new charger password, so the kit sets a new one rather than repeating.
 */
const NEVER_RETRY = new Set(["password_unconfirmed"]);

function retriable(e: IvoraError): boolean {
  if (NEVER_RETRY.has(e.code)) return false;
  if (e.status === 429) return true;
  if (RETRY_SAME_KEY.has(e.code)) return true;
  // Lost connection or timeout (the request may have arrived), or a gateway error.
  return (
    e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504
  );
}

async function toError(res: Response): Promise<IvoraError> {
  const j = (await res.json().catch(() => null)) as {
    error?: { code?: unknown; message?: unknown; details?: unknown };
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
    j?.error?.details && typeof j.error.details === "object"
      ? (j.error.details as Record<string, unknown>)
      : undefined,
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
  const now = o.now ?? Date.now;
  const attempts = o.attempts ?? 4;

  // Tenant resources live under /v1/tenants/{id}; the Stripe payment account under
  // the payment provider's own prefix.
  const roots = {
    tenant: `${origin}/v1/tenants/${o.tenantId}/`,
    stripe: `${origin}/payment/stripe/v1/tenants/${o.tenantId}/`,
    billing: `${origin}/v1/billing/`,
  };

  async function once<T>(
    method: string,
    url: string,
    body: Body | undefined,
    key: string | undefined,
    timeoutMs: number,
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${o.apiKey}`,
      accept: "application/json",
    };
    if (key) headers["idempotency-key"] = key;
    if (body) headers["content-type"] = body.contentType;
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers,
        // The same text or bytes on every try.
        body: body?.data,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
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
   * sends that same key and body, so the action happens at most once. Tries and waits
   * share one deadline (MAX_REQUEST_SECONDS), which a multi-page list passes along.
   */
  async function request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    opts: {
      /** JSON body. */
      body?: unknown;
      /** Raw body with its own content type (logo images). */
      raw?: { bytes: Uint8Array; contentType: string };
      key?: string;
      deadline?: number;
      root?: keyof typeof roots;
      /** A POST that changes nothing (a simulation): no Idempotency-Key. */
      readOnly?: boolean;
    } = {},
  ): Promise<T> {
    const deadline = opts.deadline ?? now() + MAX_REQUEST_SECONDS * 1000;
    // Second guard behind getIvora(): a live client never sends in demo mode.
    if (isDemo()) throw new Error("Demo mode never calls the Ivora API");
    if (method !== "GET" && !opts.readOnly && !(opts.key && KEY.test(opts.key)))
      throw new Error(`Idempotency-Key missing or invalid for ${method}`);
    const url = `${roots[opts.root ?? "tenant"]}${path}`;
    const body: Body | undefined = opts.raw
      ? {
          data: new Uint8Array(opts.raw.bytes),
          contentType: opts.raw.contentType,
        }
      : opts.body !== undefined
        ? { data: JSON.stringify(opts.body), contentType: "application/json" }
        : undefined;
    for (let n = 1; ; n++) {
      const left = deadline - now();
      if (left < MIN_TRY_MS)
        throw new IvoraError(
          0,
          "timeout",
          "The Ivora API did not answer in time. Try again in a minute.",
        );
      try {
        return await once<T>(
          method,
          url,
          body,
          opts.key,
          Math.min(TIMEOUT_MS, left),
        );
      } catch (e) {
        if (!(e instanceof IvoraError) || !retriable(e) || n >= attempts)
          throw e;
        const waitMs = (e.retryAfterSeconds ?? 2 ** (n - 1)) * 1000;
        // Past the deadline: hand the error (and its Retry-After) back to the caller.
        if (now() + waitMs + MIN_TRY_MS > deadline) throw e;
        await sleep(waitMs);
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

  /**
   * Follows `next_cursor` page by page, up to MAX_LIST_PAGES and one shared deadline.
   * Either limit returns what was read so far, marked truncated.
   */
  async function listAll<T>(path: string): Promise<Listed<T>> {
    const data: T[] = [];
    const deadline = now() + MAX_REQUEST_SECONDS * 1000;
    let after = 0;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      if (page > 0 && deadline - now() < MIN_TRY_MS)
        return { data, truncated: true };
      const res = await request<Page<T>>(
        "GET",
        `${path}${query({ limit: 100, after: after || undefined })}`,
        { deadline },
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

  /**
   * A create that may already have happened (a lost response, or another tab) is
   * looked up by our external_reference instead of being made twice.
   */
  async function create<T>(
    resource: "locations" | "stations" | "tokens" | "tariffs",
    body: { external_reference: string },
    key: string,
  ): Promise<T> {
    try {
      return await request<T>("POST", resource, { body, key });
    } catch (e) {
      if (!(e instanceof IvoraError) || !ADOPT_BY_REFERENCE.has(e.code))
        throw e;
      const found = await request<Page<T>>(
        "GET",
        `${resource}${list({ external_reference: body.external_reference, limit: 1 })}`,
      );
      if (found.data[0]) return found.data[0];
      throw e;
    }
  }

  return {
    mode: "live",
    async listLocations(o) {
      return (await request<Page<Location>>("GET", `locations${list(o)}`)).data;
    },
    createLocation(input: LocationInput, key: string) {
      return create<Location>("locations", input, key);
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
    createStation(input: StationInput, key: string) {
      return create<Station>("stations", input, key);
    },
    updateStation(stationId, input, key) {
      return request<Operation>("PATCH", `stations/${stationId}`, {
        body: input,
        key,
      });
    },
    async deleteStation(stationId, key) {
      await request<unknown>("DELETE", `stations/${stationId}`, { key });
    },
    // The password goes in the body only: never in a URL, a log or an error.
    setCredentials(stationId, password, key) {
      return request<Operation>("PUT", `stations/${stationId}/credentials`, {
        body: { password },
        key,
      });
    },
    sendCommand(stationId, command, key) {
      return request<Operation>("POST", `stations/${stationId}/commands`, {
        body: command,
        key,
      });
    },
    getOperation(operationId) {
      return request<Operation>(
        "GET",
        `operations/${encodeURIComponent(operationId)}`,
      );
    },
    getTransaction(transactionId) {
      return request<Transaction>("GET", `transactions/${transactionId}`);
    },
    async findToken(externalReference) {
      return (
        (
          await request<Page<TokenRecord>>(
            "GET",
            `tokens${list({ external_reference: externalReference, limit: 1 })}`,
          )
        ).data[0] ?? null
      );
    },
    createToken(input, key) {
      return create<TokenRecord>("tokens", input, key);
    },
    async listFaults(stationId, o = {}) {
      return (
        await request<Page<Fault>>(
          "GET",
          `stations/${stationId}/faults${query({ limit: o.limit ?? 20, open: o.open || undefined })}`,
        )
      ).data;
    },
    async listTransactions(o = {}) {
      return (
        await request<Page<Transaction>>(
          "GET",
          `transactions${query({ limit: o.limit ?? 50, station_id: o.station_id })}`,
        )
      ).data;
    },
    // A PUT replaces the whole record, so repeating it is harmless; the key still
    // makes a retried request count once.
    putBranding(input, key) {
      return request<Branding>("PUT", "branding", { body: input, key });
    },
    putBrandingLogo(logo, key) {
      return request<Branding>("PUT", "branding/logo", {
        raw: { bytes: logo.bytes, contentType: logo.contentType },
        key,
      });
    },
    getPaymentAccount() {
      return request<PaymentAccount>("GET", "account", { root: "stripe" });
    },
    createTariff(input, key) {
      return create<Tariff>("tariffs", input, key);
    },
    // A lookup by external_reference returns its tariff even when archived.
    async findTariff(externalReference) {
      return (
        (
          await request<Page<Tariff>>(
            "GET",
            `tariffs${list({ external_reference: externalReference, limit: 1 })}`,
          )
        ).data[0] ?? null
      );
    },
    archiveTariff(tariffId, replacementTariffId, key) {
      return request<TariffArchived>(
        "DELETE",
        `tariffs/${tariffId}${query({ replacement_tariff_id: replacementTariffId ?? undefined })}`,
        { key },
      );
    },
    // Read-only (nothing is stored), so it takes no Idempotency-Key.
    simulateTariff(tariff, session) {
      return request<Quote>("POST", "tariffs/simulate", {
        body: { tariff, session },
        key: undefined,
        readOnly: true,
      });
    },
    quoteTariff(tariffId, session) {
      return request<Quote>("POST", `tariffs/${tariffId}/quote`, {
        body: { session },
        readOnly: true,
      });
    },
    createBill(input, key) {
      return request<Bill>("POST", "bills", {
        body: { ...input, source: "csms" },
        key,
      });
    },
    getBill(billId) {
      return request<Bill>("GET", `bills/${encodeURIComponent(billId)}`);
    },
    startBill(billId, key) {
      return request<Operation>(
        "POST",
        `bills/${encodeURIComponent(billId)}/start`,
        { key },
      );
    },
    createPayment(input, key) {
      return request<Payment>("POST", "payments", {
        body: input,
        key,
        root: "stripe",
      });
    },
    getTariff(tariffId) {
      return request<Tariff>("GET", `tariffs/${tariffId}`);
    },
    finalizeBill(billId, transactionId, key) {
      return request<Bill>(
        "POST",
        `bills/${encodeURIComponent(billId)}/finalize`,
        { body: { transaction_id: transactionId }, key },
      );
    },
    getPayment(paymentId) {
      return request<Payment>(
        "GET",
        `payments/${encodeURIComponent(paymentId)}`,
        { root: "stripe" },
      );
    },
    // No amount: Ivora captures exactly the final bill.
    capturePayment(paymentId, key) {
      return request<Payment>(
        "POST",
        `payments/${encodeURIComponent(paymentId)}/capture`,
        { key, root: "stripe" },
      );
    },
    releasePayment(paymentId, key) {
      return request<Payment>(
        "POST",
        `payments/${encodeURIComponent(paymentId)}/release`,
        { key, root: "stripe" },
      );
    },
    async recordHoldStop(billId, key) {
      await request<unknown>(
        "POST",
        `bills/${encodeURIComponent(billId)}/alerts`,
        { body: { kind: "hold_stop" }, key, root: "billing" },
      );
    },
  };
}
