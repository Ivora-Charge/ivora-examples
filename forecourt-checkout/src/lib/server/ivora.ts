import "server-only";
import { z } from "zod";
import type { Quote, Tariff, TariffElement } from "../tariff";

// Routes and fields follow the published OpenAPI at
// https://api.ivoracharge.com/openapi.json (version 2026-10-15).
export const IVORA_VERSION = "2026-10-15";

export class IvoraError extends Error {
  readonly name = "IvoraError";
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId: string | null = null,
  ) {
    super(message);
  }
}

/** The API answered "retry later with the same key"; the next poll does that. */
export function isRetryLater(error: unknown) {
  return (
    error instanceof IvoraError &&
    ["request_in_progress", "outcome_unknown", "rate_limited"].includes(
      error.code,
    )
  );
}

const connectorSchema = z.object({
  id: z.number(),
  number: z.number().nullable(),
  status: z.string().nullable(),
  tariff_id: z.number().nullable(),
  max_power_w: z.number().nullable().optional(),
  type: z.string().nullable().optional(),
  format: z.string().nullable().optional(),
});
export const stationSchema = z.object({
  id: z.number(),
  name: z.string(),
  online: z.boolean(),
  external_reference: z.string().nullable().optional(),
  connectors: z.array(connectorSchema),
});
export type Station = z.infer<typeof stationSchema>;
export type Connector = z.infer<typeof connectorSchema>;

const priceComponentSchema = z.object({
  type: z.enum(["ENERGY", "TIME", "PARKING_TIME", "FLAT"]),
  price: z.number(),
  step_size: z.number().optional(),
});
const elementSchema = z.object({
  price_components: z.array(priceComponentSchema),
  restrictions: z.record(z.string(), z.unknown()).nullable().optional(),
});
export const tariffSchema = z.object({
  id: z.number(),
  currency: z.string(),
  rate_minor_per_kwh: z.number(),
  authorization_minor: z.number(),
  elements: z.array(elementSchema).nullable().optional(),
  is_complex: z.boolean().optional(),
  pricing_summary: z.string().nullable().optional(),
  archived: z.boolean().optional(),
}) satisfies z.ZodType<Tariff>;

const quoteLineSchema = z.object({
  type: z.enum(["ENERGY", "TIME", "PARKING_TIME", "FLAT"]),
  element: z.number(),
  reservation: z.boolean(),
  quantity: z.string(),
  unit: z.enum(["kWh", "h", "session"]),
  price_minor: z.string(),
  exact_minor: z.string(),
  amount_minor: z.number().int(),
});
export const quoteSchema = z.object({
  currency: z.string(),
  pricing_version: z.enum(["energy-v1", "elements-v1"]),
  lines: z.array(quoteLineSchema),
  subtotal_minor: z.number().int(),
  exact_subtotal_minor: z.string(),
  adjustments: z.array(
    z.object({
      kind: z.enum([
        "group_discount",
        "merchant_validation",
        "max_session_cost",
      ]),
      rule: z.string(),
      exact_minor: z.string(),
      amount_minor: z.number().int(),
    }),
  ),
  total_minor: z.number().int(),
  activity: z
    .object({ idle_seconds: z.number(), charging_seconds: z.number() })
    .nullable()
    .optional(),
}) satisfies z.ZodType<Quote>;

const operationSchema = z.object({
  id: z.string(),
  status: z.enum(["dispatching", "succeeded", "rejected", "unknown"]),
  result: z.record(z.string(), z.unknown()).nullable(),
  created_at: z.string(),
});
export type Operation = z.infer<typeof operationSchema>;

const usageSchema = z.object({
  transaction_id: z.number().nullable(),
  active: z.boolean(),
  energy_kwh: z.string().nullable(),
  energy_wh: z.number().int().nullable(),
  estimated_minor: z.number().int().nullable(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  power_w: z.number().nullable().optional(),
});
export const billSchema = z.object({
  id: z.string(),
  station_id: z.number(),
  connector_id: z.number(),
  /** The tariff snapshotted when the session was created. */
  tariff_id: z.number().optional(),
  status: z.enum(["open", "final"]),
  hold_minor: z.number().int(),
  currency: z.string(),
  energy_wh: z.number().int().nullable().optional(),
  total_minor: z.number().int().nullable(),
  transaction_id: z.number().nullable(),
  cost_breakdown: quoteSchema.nullable().optional(),
});
export type Bill = z.infer<typeof billSchema>;

export const externalSessionSchema = z.object({
  id: z.string(),
  application_reference: z.string(),
  payment_reference: z.string(),
  created_at: z.string(),
  status: z.enum([
    "prepared",
    "starting",
    "charging",
    "stopping",
    "awaiting_bill",
    "completed",
    "canceled",
    "reconciliation_required",
  ]),
  bill: billSchema,
  usage: usageSchema.nullable(),
  start_operation: operationSchema.nullable(),
  stop_operation: operationSchema.nullable(),
  settlement: z
    .object({
      captured_minor: z.number().int(),
      status: z.string(),
    })
    .optional(),
});
export type ExternalSession = z.infer<typeof externalSessionSchema>;

export const settlementReportSchema = z.object({
  kind: z.enum(["authorization", "capture", "refund", "release"]),
  operation_reference: z.string(),
  outcome: z.enum(["pending", "unknown", "succeeded", "failed"]),
  amount_minor: z.number().int(),
  created_at: z.string().optional(),
});

// Billed, not collected: captures are the payment provider's.
const revenueLine = z.object({
  currency: z.string(),
  billed_minor: z.number().int(),
  bills: z.number().int(),
});
export const statsSchema = z.object({
  start: z.string(),
  end: z.string(),
  totals: z.object({
    sessions: z.number(),
    ended_sessions: z.number(),
    successful_sessions: z.number(),
    success_rate: z.string().nullable(),
    energy_kwh: z.string(),
    energy_wh: z.number(),
    active_sessions: z.number(),
  }),
  stations: z.object({
    total: z.number(),
    online: z.number(),
    offline: z.number(),
    faulted: z.number(),
  }),
  revenue: z.object({ currencies: z.array(revenueLine) }).nullable(),
});
export type Stats = z.infer<typeof statsSchema>;

export const faultSchema = z.object({
  id: z.string(),
  station_id: z.number(),
  connector_id: z.number().nullable(),
  open: z.boolean(),
  error_code: z.string().nullable(),
  info: z.string().nullable(),
  vendor_error_code: z.string().nullable(),
  ocpp_status: z.string().nullable(),
  opened_at: z.string(),
  cleared_at: z.string().nullable(),
});
export type Fault = z.infer<typeof faultSchema>;

const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  request_id: z.string().optional(),
});

export type IvoraConfig = {
  apiUrl: string;
  apiKey: string;
  tenantId: string;
  fetch?: typeof fetch;
  /** Longest Retry-After (seconds) worth waiting for inside a request. */
  maxRetryAfterSeconds?: number;
};

export class IvoraClient {
  private readonly fetcher: typeof fetch;
  private readonly origin: string;
  private readonly tenant: string;

  constructor(private readonly config: IvoraConfig) {
    const url = new URL(config.apiUrl);
    if (url.protocol !== "https:") throw new Error("Ivora requires HTTPS.");
    if (!/^\d+$/.test(config.tenantId))
      throw new Error("IVORA_TENANT_ID must be a numeric tenant ID.");
    this.origin = url.origin;
    this.tenant = config.tenantId;
    this.fetcher = config.fetch ?? fetch;
  }

  private path(resource: string) {
    return `/v1/tenants/${this.tenant}/${resource}`;
  }

  async request<T>(
    method: "GET" | "POST" | "PATCH",
    resource: string,
    schema: z.ZodType<T>,
    options: {
      body?: unknown;
      idempotencyKey?: string;
      readOnly?: boolean;
    } = {},
  ): Promise<T> {
    if (method !== "GET" && !options.readOnly && !options.idempotencyKey)
      throw new Error("Every Ivora write needs an idempotency key.");
    const wait = this.config.maxRetryAfterSeconds ?? 2;
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetcher(
        new URL(this.path(resource), this.origin),
        {
          method,
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Ivora-Version": IVORA_VERSION,
            Accept: "application/json",
            ...(options.body !== undefined
              ? { "Content-Type": "application/json" }
              : {}),
            ...(options.idempotencyKey
              ? { "Idempotency-Key": options.idempotencyKey }
              : {}),
          },
          body:
            options.body === undefined
              ? undefined
              : JSON.stringify(options.body),
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (response.status === 429 && attempt === 0) {
        const retryAfter = Number(response.headers.get("retry-after") ?? "");
        if (Number.isFinite(retryAfter) && retryAfter <= wait) {
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }
      }
      if (!response.ok) throw await toError(response);
      return schema.parse(await response.json());
    }
  }

  listStations() {
    return this.request(
      "GET",
      "stations?limit=100",
      z.object({ data: z.array(stationSchema) }),
    ).then((page) => page.data);
  }

  /** The QR code carries your own code, stored as the station's external_reference. */
  async findStationByCode(code: string): Promise<Station | null> {
    const page = await this.request(
      "GET",
      `stations?external_reference=${encodeURIComponent(code)}&limit=1`,
      z.object({ data: z.array(stationSchema) }),
    );
    return page.data[0] ?? null;
  }

  getStation(id: number) {
    return this.request("GET", `stations/${id}`, stationSchema);
  }

  getTariff(id: number) {
    return this.request("GET", `tariffs/${id}`, tariffSchema);
  }

  updateTariff(
    id: number,
    body: { elements: TariffElement[]; authorization_minor: number },
    idempotencyKey: string,
  ) {
    // tariff_alt_text: null regenerates the driver-facing text from the new prices.
    return this.request("PATCH", `tariffs/${id}`, tariffSchema, {
      body: { ...body, tariff_alt_text: null },
      idempotencyKey,
    });
  }

  /** Read-only: prices a session profile with the same function bills use. */
  quote(
    tariffId: number,
    session: {
      start_at: string;
      time_zone?: string;
      duration_minutes: number;
      energy_kwh: number;
      idle_minutes?: number;
    },
  ) {
    return this.request("POST", `tariffs/${tariffId}/quote`, quoteSchema, {
      body: { session },
      readOnly: true,
    });
  }

  createSession(
    body: {
      station_id: number;
      connector_id: number;
      tariff_id: number;
      application_reference: string;
      processor: string;
      merchant_reference: string;
      payment_reference: string;
    },
    idempotencyKey: string,
  ) {
    return this.request("POST", "charging-sessions", externalSessionSchema, {
      body: { ...body, source: "csms" },
      idempotencyKey,
    });
  }

  async findSession(
    applicationReference: string,
  ): Promise<ExternalSession | null> {
    const page = await this.request(
      "GET",
      `charging-sessions?application_reference=${encodeURIComponent(applicationReference)}&limit=1`,
      z.object({ data: z.array(externalSessionSchema) }),
    );
    return page.data[0] ?? null;
  }

  listSessions(limit = 100) {
    return this.request(
      "GET",
      `charging-sessions?limit=${limit}`,
      z.object({ data: z.array(externalSessionSchema) }),
    ).then((page) => page.data);
  }

  /**
   * Every session in the project, page by page. Cursors order by opaque
   * session ID, not time, so a newer session can be on any page: read them
   * all. Stops after `maxPages` pages (10,000 sessions by default).
   */
  async listAllSessions(maxPages = 100): Promise<ExternalSession[]> {
    const all: ExternalSession[] = [];
    let after = "";
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({ limit: "100" });
      if (after) params.set("after", after);
      const result = await this.request(
        "GET",
        `charging-sessions?${params}`,
        z.object({
          data: z.array(externalSessionSchema),
          next_cursor: z.string().nullable().optional(),
        }),
      );
      all.push(...result.data);
      if (!result.next_cursor || !result.data.length) return all;
      after = result.next_cursor;
    }
    console.warn("[forecourt] session list truncated", { maxPages });
    return all;
  }

  getSession(id: string) {
    return this.request(
      "GET",
      `charging-sessions/${encodeURIComponent(id)}`,
      externalSessionSchema,
    );
  }

  startSession(id: string, idempotencyKey: string) {
    return this.request(
      "POST",
      `charging-sessions/${encodeURIComponent(id)}/start`,
      operationSchema,
      { body: { funding_confirmed: true }, idempotencyKey },
    );
  }

  stopSession(id: string, idempotencyKey: string) {
    return this.request(
      "POST",
      `charging-sessions/${encodeURIComponent(id)}/stop`,
      operationSchema,
      { idempotencyKey },
    );
  }

  cancelSession(id: string, idempotencyKey: string) {
    return this.request(
      "POST",
      `charging-sessions/${encodeURIComponent(id)}/cancel`,
      externalSessionSchema,
      { idempotencyKey },
    );
  }

  finalizeSession(id: string, transactionId: number, idempotencyKey: string) {
    return this.request(
      "POST",
      `charging-sessions/${encodeURIComponent(id)}/finalize`,
      billSchema,
      { body: { transaction_id: transactionId }, idempotencyKey },
    );
  }

  /**
   * Records what the app did with the money: the card hold, or a payment taken
   * in store. Reports never move money. `idempotencyKey` defaults to one key
   * per session and kind, which is what card payments use.
   */
  reportSettlement(
    id: string,
    report: {
      kind: "authorization" | "capture" | "release";
      operation_reference: string;
      amount_minor: number;
    },
    idempotencyKey = `${id}:report:${report.kind}`,
  ) {
    return this.request(
      "POST",
      `charging-sessions/${encodeURIComponent(id)}/settlement-reports`,
      z.unknown(),
      {
        body: { ...report, outcome: "succeeded", currency: "USD" },
        idempotencyKey,
      },
    );
  }

  /** The session's settlement audit trail, oldest first. */
  listSettlementReports(id: string) {
    return this.request(
      "GET",
      `charging-sessions/${encodeURIComponent(id)}/settlement-reports?limit=100`,
      z.object({ data: z.array(settlementReportSchema) }),
    ).then((page) => page.data);
  }

  stats(query: { from: string; to: string; timeZone: string }) {
    const params = new URLSearchParams({
      from: query.from,
      to: query.to,
      bucket: "hour",
      time_zone: query.timeZone,
    });
    return this.request("GET", `stats?${params}`, statsSchema);
  }

  faults(stationId: number, limit = 10) {
    return this.request(
      "GET",
      `stations/${stationId}/faults?limit=${limit}`,
      z.object({ data: z.array(faultSchema) }),
    ).then((page) => page.data);
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
    `Ivora request failed (${response.status}).`,
  );
}
