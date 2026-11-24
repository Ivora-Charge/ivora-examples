import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCpo, type MockCpo } from "@/lib/mock-cpo";
import { setLocationStoreForTests } from "@/lib/locations/registry";
import { MemoryLocationStore } from "@/lib/locations/store";
import { syncPeer } from "@/lib/locations/sync";
import type { ClientOptions } from "@/lib/ocpi/client";
import { connectToCpo } from "@/lib/ocpi/handshake";
import { setPeerStoreForTests } from "@/lib/ocpi/registry";
import { MemoryPeerStore, type Peer } from "@/lib/ocpi/store";
import {
  emspHandler,
  inProcessNetwork,
  installNetwork,
  LIVE_ENV,
  uninstallNetwork,
} from "./support/network";

/**
 * Per peer and module: how many pulls failed in a row, and the request ID of the last
 * failed request, kept in the pull's own stored result (no table or column).
 */

const saved = { ...process.env };
let peers: MemoryPeerStore;
let locations: MemoryLocationStore;
let cpo: MockCpo;
let peer: Peer;
let net: ReturnType<typeof inProcessNetwork>;
/**
 * What the CPO answers the next pulls with: an HTTP status, 200 for the real one, or
 * "not sent" for a request our own address check refuses before sending it.
 */
let answer: number | "not sent" = 200;
/** The X-Request-ID of every request we sent. */
let sent: string[] = [];

const client = (): ClientOptions => ({
  retries: 0,
  transport: async (url, init) => {
    if (answer === "not sent")
      throw Object.assign(new Error("not a public address"), {
        code: "peer_address_refused",
      });
    sent.push(new Headers(init?.headers).get("x-request-id") ?? "");
    if (answer === 200) return net.transport(url, init);
    return Response.json(
      {
        status_code: answer === 401 ? 2000 : 3000,
        status_message: "no",
        timestamp: "2026-11-24T00:00:00Z",
      },
      { status: answer },
    );
  },
});

beforeEach(async () => {
  Object.assign(process.env, LIVE_ENV);
  delete process.env.DEMO_MODE;
  answer = 200;
  sent = [];
  peers = new MemoryPeerStore();
  locations = new MemoryLocationStore();
  setPeerStoreForTests(peers);
  setLocationStoreForTests(locations);
  net = inProcessNetwork({
    "emsp.example.test": emspHandler,
    "mock-cpo.example.test": (r) => cpo.handle(r),
  });
  cpo = createMockCpo({ transport: net.transport });
  installNetwork(net.transport);
  peer = await connectToCpo(
    {
      label: "Mock CPO",
      versionsUrl: cpo.urls.versions,
      tokenA: cpo.issueTokenA(),
    },
    { store: peers, client: { retries: 0 } },
  );
});

afterEach(() => {
  uninstallNetwork();
  setPeerStoreForTests(undefined);
  setLocationStoreForTests(undefined);
  process.env = { ...saved };
  vi.restoreAllMocks();
});

const pull = (module: "locations" | "tariffs" = "locations") =>
  syncPeer(peer.id, module, { peers, locations, client: client() });

describe("failed pulls in a row, and the request ID of the last one", () => {
  it("counts each failure, keeps the request the CPO saw, and starts over after a good pull", async () => {
    answer = 500;
    for (const n of [1, 2, 3]) {
      await expect(pull()).rejects.toThrow();
      const r = (await locations.getSyncState(peer.id, "locations"))!
        .lastResult!;
      expect(r).toMatchObject({ ok: false, failures: n, httpStatus: 500 });
      // The request ID is the one this very request carried.
      expect(r.requestId).toBe(sent.at(-1));
      expect(r.requestId).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(new Set(sent).size).toBe(sent.length);

    answer = 200;
    await pull();
    const ok = (await locations.getSyncState(peer.id, "locations"))!
      .lastResult!;
    expect(ok.ok).toBe(true);
    expect(ok.failures).toBeUndefined();
    expect(ok.requestId).toBeUndefined();

    answer = 401;
    await expect(pull()).rejects.toThrow();
    expect(
      (await locations.getSyncState(peer.id, "locations"))!.lastResult,
    ).toMatchObject({ ok: false, failures: 1, httpStatus: 401 });
  });

  it("counts per module, not per peer", async () => {
    answer = 500;
    await expect(pull("locations")).rejects.toThrow();
    await expect(pull("locations")).rejects.toThrow();
    await expect(pull("tariffs")).rejects.toThrow();
    const failures = async (m: "locations" | "tariffs") =>
      (await locations.getSyncState(peer.id, m))!.lastResult!.failures;
    expect(await failures("locations")).toBe(2);
    expect(await failures("tariffs")).toBe(1);
  });

  it("counts on from a result stored before the count was kept", async () => {
    const old = (await locations.getSyncState(peer.id, "locations")) ?? {
      peerId: peer.id,
      module: "locations" as const,
      lastFullSyncAt: null,
      cursor: null,
      run: null,
      lastResult: null,
    };
    await locations.saveSyncState(
      {
        ...old,
        lastResult: {
          ok: false,
          mode: "full",
          finishedAt: "2026-11-23T00:00:00Z",
          items: 0,
          invalid: 0,
          removed: 0,
          error: "x",
        },
      },
      null,
    );
    answer = 500;
    await expect(pull()).rejects.toThrow();
    expect(
      (await locations.getSyncState(peer.id, "locations"))!.lastResult,
    ).toMatchObject({ failures: 2 });
  });

  it("keeps no request ID for a request that was never sent", async () => {
    answer = 500;
    await expect(pull()).rejects.toThrow();
    answer = "not sent";
    const err = await pull().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { requestId?: string }).requestId).toBeUndefined();
    const r = (await locations.getSyncState(peer.id, "locations"))!.lastResult!;
    // Still a failure in a row, but the CPO never saw a request to name.
    expect(r).toMatchObject({ ok: false, failures: 2 });
    expect(r.requestId).toBeUndefined();
    expect(r.error).toMatch(/refused: /);
  });
});
