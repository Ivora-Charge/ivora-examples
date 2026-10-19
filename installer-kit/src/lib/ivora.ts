import { randomUUID } from "node:crypto";
import type { BootInfo, TestResult } from "./types";

export const isDemo = () => !process.env.IVORA_API_KEY;

export class IvoraError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Minimal server-side client. Paths below are placeholders: confirm every path and field
 * against the published OpenAPI on the developer portal before using real credentials.
 * Error codes are surfaced with a link to the portal's errors and statuses page (IVORA_ERRORS_URL).
 */
async function call<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const base = process.env.IVORA_API_URL;
  if (!base) throw new Error("IVORA_API_URL is not set");
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.IVORA_API_KEY}`,
        "X-Tenant-Id": process.env.IVORA_TENANT_ID ?? "",
        "Content-Type": "application/json",
        ...(method !== "GET" ? { "Idempotency-Key": randomUUID() } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 2) {
      const wait = Number(res.headers.get("retry-after") ?? "1");
      await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000));
      continue;
    }
    const json = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!res.ok) {
      throw new IvoraError(
        res.status,
        String(json.code ?? "unknown_error"),
        String(json.message ?? res.statusText),
      );
    }
    return json as T;
  }
  throw new IvoraError(429, "rate_limited", "Rate limited");
}

export const createStation = (name: string, password: string) =>
  call<{ id: string }>(
    "POST",
    `/projects/${process.env.IVORA_PROJECT_ID}/stations`,
    { name, password },
  );
export const getStation = (id: string) =>
  call<{ state: string; boot?: BootInfo }>("GET", `/stations/${id}`);
export const runTest = (id: string) =>
  call<TestResult>("POST", `/stations/${id}/test-session`, {});
