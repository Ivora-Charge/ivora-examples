import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { peerStore, setPeerStoreForTests } from "@/lib/ocpi/registry";
import { MemoryPeerStore } from "@/lib/ocpi/store";
import { SupabasePeerStore } from "@/lib/ocpi/store-supabase";
import { LIVE_ENV } from "./support/network";

const ROW = {
  id: "8b0f0b5e-3c47-4c1e-9d55-4f1f0f8d2b11",
  label: "CPO",
  direction: "outbound",
  status: "registered",
  versions_url: "https://cpo.example.test/ocpi/versions",
  version: "2.2.1",
  roles: [],
  endpoints: [],
  token_ciphertext: "v1:a:b:c",
  created_at: "2026-10-21T00:00:00Z",
  updated_at: "2026-10-21T00:00:00Z",
  registered_at: "2026-10-21T00:00:00Z",
  unregistered_at: null,
};

const KEY = "test-service-role-key";
let requests: Request[];
let replies: Response[];
const transport = async (url: string | URL, init?: RequestInit) => {
  requests.push(new Request(url, init));
  return replies.shift() ?? Response.json([]);
};

beforeEach(() => {
  requests = [];
  replies = [];
});

describe("Supabase peer store (PostgREST)", () => {
  const store = new SupabasePeerStore(
    "https://db.example.test/",
    KEY,
    transport,
  );

  it("authenticates as the service role, sending the key as apikey", async () => {
    replies.push(Response.json([ROW]));
    const peer = await store.getPeer(ROW.id);
    expect(peer).toMatchObject({
      id: ROW.id,
      versionsUrl: ROW.versions_url,
      tokenCiphertext: ROW.token_ciphertext,
    });
    const [r] = requests;
    expect(r.url).toBe(
      `https://db.example.test/rest/v1/emsp_ocpi_peers?id=eq.${ROW.id}&select=*`,
    );
    expect(r.headers.get("apikey")).toBe(KEY);
    // Not a JWT: no Authorization header.
    expect(r.headers.has("authorization")).toBe(false);

    const jwt = new SupabasePeerStore(
      "https://db.example.test",
      "a.b.c",
      transport,
    );
    await jwt.listPeers();
    expect(requests[1].headers.get("authorization")).toBe("Bearer a.b.c");
  });

  it("updates conditionally on the status, mapping columns", async () => {
    replies.push(Response.json([]));
    const res = await store.updatePeer(
      ROW.id,
      { status: "registered", tokenCiphertext: "v1:x:y:z" },
      "pending",
    );
    expect(res).toBeNull();
    const [r] = requests;
    expect(r.method).toBe("PATCH");
    expect(new URL(r.url).search).toBe(`?id=eq.${ROW.id}&status=eq.pending`);
    expect(r.headers.get("prefer")).toBe("return=representation");
    expect(await r.json()).toMatchObject({
      status: "registered",
      token_ciphertext: "v1:x:y:z",
      updated_at: expect.any(String),
    });
  });

  it("finds only active tokens and revokes all but one", async () => {
    const hash = "a".repeat(64);
    await store.findToken(hash);
    await store.revokePeerTokens(ROW.id, hash);
    expect(decodeURIComponent(requests[0].url)).toContain(
      `emsp_ocpi_issued_tokens?token_hash=eq.${hash}&revoked_at=is.null`,
    );
    expect(decodeURIComponent(requests[1].url)).toContain(
      `peer_id=eq.${ROW.id}&revoked_at=is.null&token_hash=neq.${hash}`,
    );
    expect(await requests[1].json()).toEqual({
      revoked_at: expect.any(String),
    });
  });

  it("writes audit entries without secrets", async () => {
    await store.audit({
      actor: "admin",
      action: "ocpi.peer.invited",
      subjectId: ROW.id,
    });
    expect(await requests[0].json()).toEqual({
      actor: "admin",
      action: "ocpi.peer.invited",
      subject_type: "ocpi_peer",
      subject_id: ROW.id,
      request_id: null,
      details: {},
    });
  });

  it("reports failures by table and status only", async () => {
    replies.push(
      new Response(`{"message":"duplicate ${KEY}"}`, { status: 409 }),
    );
    const err = await store
      .issueToken({ hash: "b".repeat(64), peerId: ROW.id, scope: "full" })
      .catch((e) => e);
    expect(err.message).toBe(
      "Database request failed: POST emsp_ocpi_issued_tokens (HTTP 409)",
    );
  });
});

describe("peer registry selection", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    setPeerStoreForTests(undefined);
    vi.unstubAllGlobals();
  });

  it("uses memory in demo mode and Supabase in live mode", () => {
    process.env.DEMO_MODE = "true";
    const demo = peerStore();
    expect(demo).toBeInstanceOf(MemoryPeerStore);
    expect(peerStore()).toBe(demo);
    Object.assign(process.env, LIVE_ENV);
    delete process.env.DEMO_MODE;
    expect(peerStore()).toBeInstanceOf(SupabasePeerStore);
  });

  it("never reaches the database in demo mode", async () => {
    process.env.DEMO_MODE = "true";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const store = new SupabasePeerStore("https://db.example.test", KEY);
    await expect(store.listPeers()).rejects.toThrow(/Demo mode/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
