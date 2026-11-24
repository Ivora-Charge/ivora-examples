import "server-only";
import { outboundFetch } from "./demo";

/**
 * Requests to Supabase's Data API (PostgREST) as the service role. They go through
 * `outboundFetch`, so demo mode never reaches it. Errors name the table and HTTP status
 * only, never the key or row values.
 */
export type SupabaseTransport = typeof outboundFetch;

/**
 * One request, answered as it came: for a caller that needs the status of a refusal
 * (the database check tells "no such table" from "no answer"). Nothing is thrown for a
 * status; a request that gets no answer rejects.
 */
export function supabaseRequest(
  url: string,
  serviceRoleKey: string,
  transport: SupabaseTransport = outboundFetch,
  /** How long a request may take. Setup's probes ask with a shorter one. */
  timeoutMs = 10_000,
) {
  return function request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    prefer?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      apikey: serviceRoleKey,
      Accept: "application/json",
    };
    // Legacy service_role keys are JWTs and go in Authorization too; newer secret
    // keys are not JWTs and are sent as `apikey` only.
    if (serviceRoleKey.split(".").length === 3)
      headers.Authorization = `Bearer ${serviceRoleKey}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (prefer) headers.Prefer = prefer;
    return transport(`${url.replace(/\/+$/, "")}/rest/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  };
}

/**
 * A refused request: the table and the HTTP status in its message, and the error code
 * of the answer (PostgREST's or Postgres's own, for example "no such table") when it
 * had one. Never the key, the query or a row.
 */
export class DatabaseRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "DatabaseRequestError";
  }
}

/**
 * How PostgREST and Postgres say "that table, column or function does not exist":
 * PGRST202 (no such function), PGRST204 (no such column), PGRST205 (no such table),
 * and Postgres's 42P01, 42703 and 42883 for the same three.
 */
export const ABSENT_CODES: ReadonlySet<string> = new Set([
  "PGRST202",
  "PGRST204",
  "PGRST205",
  "42P01",
  "42703",
  "42883",
]);

/** The error code of a refusal's body, if it has one. */
export async function errorCode(res: Response): Promise<string | null> {
  const body = (await res.json().catch(() => null)) as {
    code?: unknown;
  } | null;
  return typeof body?.code === "string" ? body.code : null;
}

export function supabaseRest(
  url: string,
  serviceRoleKey: string,
  transport: SupabaseTransport = outboundFetch,
) {
  const request = supabaseRequest(url, serviceRoleKey, transport);
  return async function rest<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    prefer?: string,
  ): Promise<T> {
    const table = path.split("?")[0];
    const res = await request(method, path, body, prefer);
    if (!res.ok)
      throw new DatabaseRequestError(
        `Database request failed: ${method} ${table} (HTTP ${res.status})`,
        res.status,
        await errorCode(res),
      );
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  };
}

/** `eq.<value>`, encoded for a query string. */
export const eq = (v: string) => `eq.${encodeURIComponent(v)}`;

/** `in.("a","b")`, quoting each value so commas and parentheses stay literal. */
export const inList = (values: string[]) =>
  `in.(${values.map((v) => encodeURIComponent(`"${v.replace(/["\\]/g, "\\$&")}"`)).join(",")})`;
