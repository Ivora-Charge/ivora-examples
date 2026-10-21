import { vi } from "vitest";
import * as versionsRoute from "@/app/ocpi/versions/route";
import * as detailsRoute from "@/app/ocpi/2.2.1/route";
import * as credentialsRoute from "@/app/ocpi/2.2.1/credentials/route";
import type { Transport } from "@/lib/ocpi/client";

type Handler = (request: Request) => Promise<Response>;

/** Live-mode settings for tests. Values are fakes. */
export const LIVE_ENV = {
  EMSP_COUNTRY_CODE: "nl",
  EMSP_PARTY_ID: "abc",
  PUBLIC_BASE_URL: "https://emsp.example.test",
  SUPABASE_URL: "https://db.example.test",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  OCPI_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

/** This eMSP's OCPI routes, as Next.js would dispatch them. */
export const emspHandler: Handler = async (request) => {
  const routes: Record<string, Record<string, unknown>> = {
    "/ocpi/versions": versionsRoute,
    "/ocpi/2.2.1": detailsRoute,
    "/ocpi/2.2.1/credentials": credentialsRoute,
  };
  const route = routes[new URL(request.url).pathname];
  const handler = route?.[request.method] as Handler | undefined;
  if (!handler) return new Response("Not found", { status: 404 });
  return handler(request);
};

/**
 * A network made of in-process servers, by host. Unknown hosts fail like an
 * unreachable server. Nothing leaves the process.
 */
export function inProcessNetwork(hosts: Record<string, Handler>) {
  const calls: { method: string; url: string }[] = [];
  const transport: Transport = async (url, init) => {
    const request = new Request(url, init);
    calls.push({ method: request.method, url });
    const handler = hosts[new URL(url).host];
    if (!handler) throw new TypeError("fetch failed");
    return handler(request);
  };
  return { transport, calls };
}

/** Routes the global fetch (behind outboundFetch) to the in-process network. */
export function installNetwork(transport: Transport) {
  vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) =>
    transport(String(input), init ?? {}),
  );
}
