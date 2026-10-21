import { vi } from "vitest";
import * as versionsRoute from "@/app/ocpi/versions/route";
import * as detailsRoute from "@/app/ocpi/2.2.1/route";
import * as credentialsRoute from "@/app/ocpi/2.2.1/credentials/route";
import type { Transport } from "@/lib/ocpi/client";
import { setPeerNetworkForTests } from "@/lib/server/peer-fetch";

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
    // Abort like fetch does, from the caller's own signal: a Request follows it only
    // through a weak reference, which garbage collection can drop under load.
    const signal = init.signal;
    if (!signal) return handler(request);
    return new Promise<Response>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
      handler(request).then(resolve, reject);
    });
  };
  return { transport, calls };
}

/** A public address the fake DNS gives every host. Never connected to. */
export const FAKE_PUBLIC_ADDRESS = "93.184.215.14";

/**
 * Routes outbound requests to the in-process network: the global fetch (behind
 * outboundFetch), and peerFetch after its address check, with a fake DNS that resolves
 * every host to a public address. Undo with `uninstallNetwork`.
 */
export function installNetwork(transport: Transport) {
  vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) =>
    transport(String(input), init ?? {}),
  );
  setPeerNetworkForTests({
    resolve: async () => [{ address: FAKE_PUBLIC_ADDRESS, family: 4 }],
    send: (url, init) => transport(url.toString(), init),
  });
}

export function uninstallNetwork() {
  vi.unstubAllGlobals();
  setPeerNetworkForTests(undefined);
}
