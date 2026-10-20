import { vi } from "vitest";

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

type Handler = (c: Call) => {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
};

/** A fetch stand-in that records requests and answers from a handler; never touches the network. */
export function fakeFetch(handler: Handler) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const c: Call = {
      method: init.method ?? "GET",
      url: String(url),
      headers: Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(
          ([k, v]) => [k.toLowerCase(), v],
        ),
      ),
      body: typeof init.body === "string" ? init.body : undefined,
    };
    calls.push(c);
    const r = handler(c);
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

export function liveEnv() {
  process.env.DEMO_MODE = "";
  process.env.IVORA_API_KEY = "iv_test_not_a_real_key";
  process.env.IVORA_TENANT_ID = "7";
  process.env.IVORA_API_BASE_URL = "";
}
