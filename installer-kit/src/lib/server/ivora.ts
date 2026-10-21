import "server-only";
import { z } from "zod";
import type { Backend, TransactionSnapshot } from "./backend";
import type { LiveConfig } from "./config";
import { HttpError, IvoraError } from "./errors";
import { stationState } from "../status";
import { kwhTextToWh } from "../units";
import type { ConfigKey } from "../types";

// Schemas follow the published OpenAPI (https://api.ivoracharge.com/openapi.json).
// Only the fields this template reads are listed; others are ignored.
const nullableString = z.string().nullable().optional();

const stationSchema = z.object({
  id: z.number(),
  name: z.string(),
  online: z.boolean(),
  protocol: nullableString,
  vendor: nullableString,
  model: nullableString,
  last_seen: nullableString,
  connection_url: z.string(),
  username: nullableString,
  connectors: z.array(
    z.object({
      id: z.number(),
      number: z.number().nullable(),
      status: nullableString,
    }),
  ),
});

const locationSchema = z.object({
  id: z.number(),
  name: z.string(),
  address: nullableString,
  city: nullableString,
});

const operationSchema = z.object({
  id: z.string(),
  status: z.enum(["dispatching", "succeeded", "rejected", "unknown"]),
  result: z.record(z.string(), z.unknown()).nullable(),
});
type Operation = z.infer<typeof operationSchema>;

const transactionSchema = z.object({
  id: z.number(),
  connector_id: z.number().nullable().optional(),
  id_token: nullableString,
  active: z.boolean().nullable(),
  started_at: nullableString,
  ended_at: nullableString,
  energy_kwh: z.union([z.string(), z.number()]).nullable().optional(),
  energy_wh: z.number().nullable().optional(),
});

const configurationSchema = z.object({
  data: z.array(z.object({ key: z.string(), value: nullableString })),
});

const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  request_id: z.string().optional(),
});

const page = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item) });

/** Codes after which the same request may be repeated with the same key. */
const RETRY_SAME_KEY = new Set(["request_in_progress", "outcome_unknown"]);
/** Creates that may already have happened: adopt the record by reference. */
const ADOPT_BY_REFERENCE = new Set([
  "external_reference_taken",
  "outcome_unknown",
  "request_in_progress",
]);
const MAX_ATTEMPTS = 4;
const MAX_WAIT_SECONDS = 10;

export type ClientOptions = LiveConfig & {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export class IvoraClient {
  private fetch: typeof fetch;
  private sleep: (ms: number) => Promise<void>;

  constructor(private options: ClientOptions) {
    this.fetch = options.fetch ?? fetch;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  path(resource: string) {
    return `/v1/tenants/${this.options.tenantId}/${resource}`;
  }

  /**
   * One API call. Writes carry an Idempotency-Key derived from our record and
   * action; every retry (429, 5xx, lost response, request_in_progress,
   * outcome_unknown) reuses that same key so the action happens at most once.
   */
  async request<T>(
    method: "GET" | "POST" | "PUT",
    resource: string,
    schema: z.ZodType<T>,
    opts: { body?: unknown; key?: string } = {},
  ): Promise<T> {
    if (method !== "GET" && !opts.key)
      throw new Error("Writes to the Ivora API need an idempotency key.");
    let last: IvoraError | null = null;
    let wait: number | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await this.sleep(wait ?? 500 * 2 ** (attempt - 1));
      wait = null;
      let response: Response;
      try {
        response = await this.fetch(
          new URL(this.path(resource), this.options.origin),
          {
            method,
            headers: {
              Authorization: `Bearer ${this.options.apiKey}`,
              Accept: "application/json",
              ...(opts.body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
              ...(opts.key ? { "Idempotency-Key": opts.key } : {}),
            },
            body:
              opts.body === undefined ? undefined : JSON.stringify(opts.body),
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
          },
        );
      } catch {
        // Timeout or lost connection: the request may have arrived. Repeat it
        // with the same key so Ivora answers with the original outcome.
        last = new IvoraError(503, "network_error", "Ivora did not answer.");
        continue;
      }
      if (response.ok) return schema.parse(await response.json());
      last = await toError(response);
      if (!this.retryable(response, last)) throw last;
      const after = retryAfter(response);
      if (after !== null) wait = after * 1000;
    }
    throw last ?? new IvoraError(503, "network_error", "Ivora did not answer.");
  }

  private retryable(response: Response, error: IvoraError) {
    if (response.status === 429) {
      const wait = retryAfter(response);
      // Long waits (such as credential change limits) go back to the operator.
      return wait === null || wait <= MAX_WAIT_SECONDS;
    }
    if (RETRY_SAME_KEY.has(error.code)) return true;
    // password_unconfirmed asks for a new key; never repeat it automatically.
    if (error.code === "password_unconfirmed") return false;
    return response.status >= 500 && response.status !== 501;
  }

  /** Dispatch an operation and wait briefly for the charger's answer. */
  async operation(
    method: "POST" | "PUT",
    resource: string,
    body: unknown,
    key: string,
  ): Promise<Operation> {
    let op = await this.request(method, resource, operationSchema, {
      body,
      key,
    });
    for (let i = 0; i < 10 && op.status === "dispatching"; i++) {
      await this.sleep(1000);
      op = await this.request("GET", `operations/${op.id}`, operationSchema);
    }
    if (op.status === "rejected") {
      const error = op.result?.error as
        { code?: unknown; message?: unknown } | undefined;
      throw new IvoraError(
        409,
        typeof error?.code === "string" ? error.code : "rejected",
        typeof error?.message === "string"
          ? error.message
          : "The request was rejected.",
        null,
        true,
      );
    }
    return op;
  }

  /** Create a location or station; on an uncertain outcome, adopt it by reference. */
  async create<T>(
    resource: "locations" | "stations",
    schema: z.ZodType<T>,
    body: Record<string, unknown> & { external_reference: string },
    key: string,
  ): Promise<T> {
    try {
      return await this.request("POST", resource, schema, { body, key });
    } catch (error) {
      if (!(error instanceof IvoraError) || !ADOPT_BY_REFERENCE.has(error.code))
        throw error;
      const found = await this.request(
        "GET",
        `${resource}?external_reference=${encodeURIComponent(body.external_reference)}&limit=1`,
        page(schema),
      );
      if (found.data[0]) return found.data[0];
      throw error;
    }
  }
}

async function toError(response: Response) {
  const parsed = errorSchema.safeParse(await response.json().catch(() => null));
  if (parsed.success)
    return new IvoraError(
      response.status,
      parsed.data.error.code,
      parsed.data.error.message,
      parsed.data.request_id ?? null,
    );
  return new IvoraError(
    response.status,
    response.status === 429 ? "rate_limited" : "http_error",
    `Ivora request failed (HTTP ${response.status}).`,
  );
}

function retryAfter(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value || !/^\d+$/.test(value)) return null;
  return Number(value);
}

function chargerStatus(op: Operation) {
  const status = op.result?.charger_status;
  return typeof status === "string" ? status : null;
}

function toTransaction(t: z.infer<typeof transactionSchema>) {
  return {
    connectorResourceId: t.connector_id == null ? null : String(t.connector_id),
    idToken: t.id_token ?? null,
    transactionId: String(t.id),
    // The API may report null while a transaction's state is unknown; fall
    // back to whether it has ended.
    active: t.active ?? !t.ended_at,
    startedAt: t.started_at ?? null,
    endedAt: t.ended_at ?? null,
    energyWh:
      typeof t.energy_wh === "number"
        ? t.energy_wh
        : kwhTextToWh(t.energy_kwh ?? null),
  } satisfies TransactionSnapshot;
}

// Operator test sessions present this ID tag; it never authorizes payment.
export const TEST_ID_TAG = "INSTALLER-TEST";

/** The API shows only the last four characters of a token, behind asterisks. */
const isTestToken = (idToken: string | null | undefined) =>
  !!idToken && idToken.toUpperCase().endsWith(TEST_ID_TAG.slice(-4));

export function liveBackend(client: IvoraClient): Backend {
  return {
    demo: false,

    async listLocations() {
      const res = await client.request(
        "GET",
        "locations?limit=50",
        page(locationSchema),
      );
      return res.data.map((l) => ({
        locationId: String(l.id),
        name: l.name,
        address: [l.address, l.city].filter(Boolean).join(", "),
      }));
    },

    async createLocation(site, key) {
      const location = await client.create(
        "locations",
        locationSchema,
        {
          name: site.name,
          address: site.address,
          city: site.city,
          state: site.state,
          postal_code: site.postalCode,
          country: site.country,
          external_reference: `installer-kit:site:${site.id}`,
        },
        key,
      );
      return String(location.id);
    },

    async createStation({ key, reference, name, locationId, connectors }) {
      const station = await client.create(
        "stations",
        stationSchema,
        {
          name,
          location_id: Number(locationId),
          connectors,
          external_reference: reference,
        },
        key,
      );
      return {
        stationId: String(station.id),
        connectionUrl: station.connection_url,
        username: station.username ?? station.name,
      };
    },

    async setPassword(stationId, password, key) {
      // A new station is offline, so Ivora stores the password for its first
      // connection. The password is never returned or logged by the API.
      const op = await client.operation(
        "PUT",
        `stations/${stationId}/credentials`,
        { password },
        key,
      );
      if (op.status !== "succeeded")
        throw new HttpError(
          503,
          "password_unconfirmed",
          "Ivora has not confirmed the new password yet. Set a new password before the charger connects.",
        );
    },

    async getStation(stationId) {
      const s = await client.request(
        "GET",
        `stations/${stationId}`,
        stationSchema,
      );
      return {
        state: stationState({
          online: s.online,
          protocol: s.protocol ?? null,
          lastSeen: s.last_seen,
        }),
        boot:
          s.vendor || s.model
            ? {
                vendor: s.vendor ?? null,
                model: s.model ?? null,
                firmware: null,
              }
            : null,
        connectors: s.connectors.map((c, i) => ({
          resourceId: String(c.id),
          number: c.number ?? i + 1,
          status: c.status ?? null,
        })),
      };
    },

    async startCharging(stationId, connectorResourceId, key) {
      const op = await client.operation(
        "POST",
        `stations/${stationId}/commands`,
        {
          action: "start",
          connector_id: Number(connectorResourceId),
          token: TEST_ID_TAG,
          token_type: "Central",
        },
        key,
      );
      const answer = chargerStatus(op);
      if (answer && answer !== "Accepted")
        throw new HttpError(
          409,
          "start_not_accepted",
          `The charger answered ${answer} to the start request. Plug in a vehicle or check the connector is available.`,
        );
    },

    async findTransaction(stationId, connectorResourceId, since) {
      const res = await client.request(
        "GET",
        `transactions?station_id=${encodeURIComponent(stationId)}&limit=10`,
        page(transactionSchema),
      );
      const from = Date.parse(since);
      const match = res.data
        .filter(
          (t) =>
            String(t.connector_id) === connectorResourceId &&
            isTestToken(t.id_token) &&
            Date.parse(t.started_at ?? "") >= from,
        )
        .sort(
          (a, b) =>
            Date.parse(b.started_at ?? "") - Date.parse(a.started_at ?? ""),
        )[0];
      return match ? toTransaction(match) : null;
    },

    async hasActiveTransaction(stationId, connectorResourceId) {
      const res = await client.request(
        "GET",
        `transactions?station_id=${encodeURIComponent(stationId)}&limit=10`,
        page(transactionSchema),
      );
      return res.data.some(
        (t) =>
          // A session that reports no connector might be on this one.
          (t.connector_id == null ||
            String(t.connector_id) === connectorResourceId) &&
          toTransaction(t).active,
      );
    },

    async getTransaction(transactionId) {
      return toTransaction(
        await client.request(
          "GET",
          `transactions/${transactionId}`,
          transactionSchema,
        ),
      );
    },

    async stopCharging(stationId, transactionId, key) {
      await client.operation(
        "POST",
        `stations/${stationId}/commands`,
        { action: "stop", transaction_id: Number(transactionId) },
        key,
      );
    },

    async readConfiguration(stationId, keys, key) {
      // The read is what the core recorded, so ask the charger for a fresh report first.
      await client.operation(
        "POST",
        `stations/${stationId}/configuration/refresh`,
        undefined,
        key,
      );
      const values = {} as Record<ConfigKey, string | null>;
      for (const k of keys) {
        const res = await client.request(
          "GET",
          `stations/${stationId}/configuration?key=${encodeURIComponent(k)}`,
          configurationSchema,
        );
        values[k] = res.data.find((item) => item.key === k)?.value ?? null;
      }
      return values;
    },

    async changeConfiguration(stationId, configKey, value, key) {
      const op = await client.operation(
        "POST",
        `stations/${stationId}/configuration`,
        { key: configKey, value },
        key,
      );
      return chargerStatus(op) ?? op.status;
    },
  };
}
