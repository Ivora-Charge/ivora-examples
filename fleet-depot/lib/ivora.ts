import "server-only";
import { config, isDemo } from "./config";

/**
 * Ivora API client, server-side only. Paths and shapes follow the published OpenAPI
 * (https://api.ivoracharge.com/openapi.json). The API key and tenant ID never leave
 * the server: the browser talks to this app's routes only.
 */

export const ERRORS_URL =
  "https://ivoracharge.com/developers/guides/reference/errors";

export class IvoraError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
    public requestId?: string,
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
  /** Retrying with the same Idempotency-Key is safe and may succeed. */
  get retriable() {
    return (
      this.status === 429 ||
      this.code === "request_in_progress" ||
      this.code === "outcome_unknown" ||
      this.status === 502 ||
      this.status === 503 ||
      this.status === 0
    );
  }
}

export interface TokenRecord {
  id: number;
  id_token: string;
  status: "Accepted" | "Blocked" | "Expired" | string;
  label?: string | null;
  external_reference?: string | null;
}

export interface ImportResult {
  dry_run: boolean;
  counts: Record<string, number>;
  rows: {
    row: number;
    id_token: string | null;
    action: "create" | "update" | "unchanged" | "error";
    token_id?: number | null;
    code?: string | null;
    message?: string | null;
  }[];
}

export interface Operation {
  id: string;
  status: "dispatching" | "succeeded" | "rejected" | "unknown";
  result: Record<string, unknown> | null;
}

export interface CompositeSchedule {
  start_at?: string;
  duration_seconds?: number;
  unit?: "W" | "A";
  periods: { start_offset_seconds: number; limit: number }[];
}

export interface ProfileInput {
  purpose: "session" | "tx_default" | "charger_max";
  unit: "W" | "A";
  transaction_id?: number;
  connector_id?: number;
  stack_level?: number;
  kind?: "absolute" | "relative";
  start_at?: string;
  duration_seconds?: number;
  periods: { start_offset_seconds: number; limit: number }[];
}

export interface StationRecord {
  id: number;
  name: string;
  protocol?: string | null;
  connectors: {
    id: number;
    number?: number | null;
    status?: string | null;
    max_power_w?: number | null;
  }[];
}

export interface TransactionDetail {
  id: number;
  station_id: number | null;
  connector_id: number | null;
  connector_number: number | null;
  /** Last 4 characters behind ****; the API never returns the full card value. */
  id_token: string | null;
  active: boolean | null;
  started_at: string | null;
  ended_at: string | null;
  energy_wh?: number | null;
  meter_start_wh?: number | null;
}

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  tenantId: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Attempts for retriable failures (429, request_in_progress, outcome_unknown, 5xx, network). */
  attempts?: number;
}

interface CallOptions {
  body?: unknown;
  csv?: string;
  /** Required on every write. Derive it from your own record and action. */
  key?: string;
  /** Retry 503 outcome_unknown with the same key (default true). */
  retryUnknown?: boolean;
}

const KEY = /^[\x21-\x7e]{8,128}$/;

export function createIvora(o: ClientOptions) {
  const doFetch: typeof fetch = (...a) => (o.fetch ?? globalThis.fetch)(...a);
  const sleep =
    o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const attempts = o.attempts ?? 4;
  if (!/^\d+$/.test(o.tenantId))
    throw new Error("IVORA_TENANT_ID must be the numeric tenant ID");

  async function once<T>(
    method: string,
    path: string,
    c: CallOptions,
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${o.apiKey}`,
      accept: "application/json",
    };
    if (c.key) headers["idempotency-key"] = c.key;
    let body: string | undefined;
    if (c.csv !== undefined) {
      headers["content-type"] = "text/csv";
      body = c.csv;
    } else if (c.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(c.body);
    }
    let res: Response;
    try {
      res = await doFetch(`${o.baseUrl}/v1/tenants/${o.tenantId}${path}`, {
        method,
        headers,
        body,
        cache: "no-store",
      });
    } catch {
      throw new IvoraError(0, "network_error", "Could not reach the Ivora API");
    }
    if (res.ok) {
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    }
    const j = (await res.json().catch(() => ({}))) as {
      error?: {
        code?: string;
        message?: string;
        details?: Record<string, unknown>;
      };
      request_id?: string;
    };
    const retry = Number(res.headers.get("retry-after"));
    throw new IvoraError(
      res.status,
      j.error?.code ?? `http_${res.status}`,
      j.error?.message ?? res.statusText,
      j.error?.details ?? undefined,
      j.request_id,
      Number.isFinite(retry) && retry > 0 ? retry : undefined,
    );
  }

  async function call<T>(
    method: string,
    path: string,
    c: CallOptions = {},
  ): Promise<T> {
    // The one place that guards demo mode: it never sends anything to a real service.
    if (isDemo()) throw new Error("Demo mode never calls the Ivora API");
    if (method !== "GET" && !(c.key && KEY.test(c.key)))
      throw new Error(`Idempotency-Key missing or invalid for ${method}`);
    for (let n = 1; ; n++) {
      try {
        return await once<T>(method, path, c);
      } catch (e) {
        const last = n >= attempts;
        if (!(e instanceof IvoraError) || !e.retriable || last) throw e;
        if (e.code === "outcome_unknown" && c.retryUnknown === false) throw e;
        // Same key and same body on every retry. Honour Retry-After, else back off.
        const waitS = e.retryAfterSeconds ?? 2 ** (n - 1);
        await sleep(Math.min(waitS, 30) * 1000);
      }
    }
  }

  const enc = encodeURIComponent;

  return {
    listTokens: (q: { external_reference?: string; id_token?: string }) => {
      const p = new URLSearchParams(q as Record<string, string>);
      return call<{ data: TokenRecord[] }>("GET", `/tokens?${p}`);
    },
    createToken: (
      body: { id_token: string; external_reference?: string; label?: string },
      key: string,
    ) =>
      call<TokenRecord>("POST", "/tokens", {
        body: { type: "ISO14443", status: "Accepted", ...body },
        key,
      }),
    updateToken: (
      tokenId: number,
      body: { status?: "Accepted" | "Blocked" | "Expired" },
      key: string,
    ) => call<TokenRecord>("PATCH", `/tokens/${tokenId}`, { body, key }),
    importTokens: (csv: string, key: string) =>
      call<ImportResult>("POST", "/tokens/import", {
        csv,
        key,
        // The import guide: after 503 outcome_unknown, re-run the same file with a new key.
        retryUnknown: false,
      }),
    getStation: (stationId: number) =>
      call<StationRecord>("GET", `/stations/${stationId}`),
    getTransaction: (transactionId: number) =>
      call<TransactionDetail>("GET", `/transactions/${transactionId}`),
    setChargingProfile: (stationId: number, body: ProfileInput, key: string) =>
      call<Operation>("POST", `/stations/${stationId}/charging-profiles`, {
        body,
        key,
      }),
    clearChargingProfile: (stationId: number, profileId: string, key: string) =>
      call<Operation>(
        "DELETE",
        `/stations/${stationId}/charging-profiles/${enc(profileId)}`,
        { key },
      ),
    compositeSchedule: (
      stationId: number,
      body: { duration_seconds: number; connector_id?: number; unit?: "W" },
      key: string,
    ) =>
      call<Operation>("POST", `/stations/${stationId}/composite-schedule`, {
        body,
        key,
      }),
    getOperation: (operationId: string) =>
      call<Operation>("GET", `/operations/${enc(operationId)}`),
    sleep,
  };
}

export type Ivora = ReturnType<typeof createIvora>;

let client: Ivora | undefined;
/** The live client for this deployment's credentials. */
export function ivora(): Ivora {
  client ??= createIvora({
    baseUrl: config.apiBase,
    apiKey: config.apiKey,
    tenantId: config.tenantId,
  });
  return client;
}

/** Replace the live client (tests inject one with a fake fetch and no-op sleep). */
export function setIvora(c: Ivora | undefined) {
  client = c;
}

/** Operator-facing message: the API's code, what to do, and a link to the errors page. */
export function describeError(e: unknown): string {
  if (e instanceof IvoraError) {
    const wait = e.retryAfterSeconds
      ? ` Retry in ${e.retryAfterSeconds}s.`
      : "";
    const req = e.requestId ? ` Request ${e.requestId}.` : "";
    const who =
      e.status === 401 || e.status === 403
        ? " Check the API key and its permissions."
        : e.retriable
          ? " Temporary: it is retried with the same idempotency key."
          : "";
    return `Ivora API error ${e.code} (HTTP ${e.status || "-"}): ${e.message}.${who}${wait}${req} See ${ERRORS_URL}`;
  }
  return e instanceof Error ? e.message : "Unknown error";
}
