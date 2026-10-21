import "server-only";
import { outboundFetch } from "./demo";

/**
 * Requests to Supabase's Data API (PostgREST) as the service role. They go through
 * `outboundFetch`, so demo mode never reaches it. Errors name the table and HTTP status
 * only, never the key or row values.
 */
export type SupabaseTransport = typeof outboundFetch;

export function supabaseRest(
  url: string,
  serviceRoleKey: string,
  transport: SupabaseTransport = outboundFetch,
) {
  return async function rest<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    prefer?: string,
  ): Promise<T> {
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
    const table = path.split("?")[0];
    const res = await transport(`${url.replace(/\/+$/, "")}/rest/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(
        `Database request failed: ${method} ${table} (HTTP ${res.status})`,
      );
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  };
}

/** `eq.<value>`, encoded for a query string. */
export const eq = (v: string) => `eq.${encodeURIComponent(v)}`;

/** `in.("a","b")`, quoting each value so commas and parentheses stay literal. */
export const inList = (values: string[]) =>
  `in.(${values.map((v) => encodeURIComponent(`"${v.replace(/["\\]/g, "\\$&")}"`)).join(",")})`;
