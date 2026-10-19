import { randomUUID } from "node:crypto";
import { config } from "./config";

export class IvoraError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export const ERRORS_URL =
  "https://developers.ivora.example/errors-and-statuses";

/** Server-side only. The API key and tenant ID never reach the browser. */
async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const res = await fetch(`${config.apiBase}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "x-tenant-id": config.tenantId,
      "content-type": "application/json",
      ...(method !== "GET"
        ? { "idempotency-key": idempotencyKey ?? randomUUID() }
        : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as {
      code?: string;
      message?: string;
    };
    const retry = Number(res.headers.get("retry-after")) || undefined;
    throw new IvoraError(
      res.status,
      j.code ?? String(res.status),
      j.message ?? res.statusText,
      retry,
    );
  }
  return (await res.json()) as T;
}

export const ivora = {
  createToken: (idTag: string, label: string, key?: string) =>
    call("POST", "/tokens", { idTag, label, status: "accepted" }, key),
  blockToken: (idTag: string) =>
    call("PATCH", `/tokens/${encodeURIComponent(idTag)}`, {
      status: "blocked",
    }),
  setChargingProfile: (
    stationId: string,
    connectorId: number,
    profile: unknown,
    key?: string,
  ) =>
    call(
      "POST",
      `/stations/${stationId}/charging-profiles`,
      { connectorId, profile },
      key,
    ),
  compositeSchedule: (
    stationId: string,
    connectorId: number,
    durationSeconds: number,
  ) =>
    call<{ chargingSchedulePeriod?: { startPeriod: number; limit: number }[] }>(
      "GET",
      `/stations/${stationId}/composite-schedule?connectorId=${connectorId}&duration=${durationSeconds}`,
    ),
};

/** User-facing message with a link to the errors page. */
export function describeError(e: unknown): string {
  if (e instanceof IvoraError) {
    const wait = e.retryAfterSeconds
      ? ` Retry in ${e.retryAfterSeconds}s.`
      : "";
    return `Ivora API error ${e.code} (HTTP ${e.status}): ${e.message}.${wait} See ${ERRORS_URL}`;
  }
  return e instanceof Error ? e.message : "Unknown error";
}
