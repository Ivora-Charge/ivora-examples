import { createServer, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCpo, type MockCpo } from "@/lib/mock-cpo";
import {
  MAX_RESPONSE_BYTES,
  ocpiRequest,
  type ClientOptions,
} from "@/lib/ocpi/client";
import {
  connectToCpo,
  HandshakeError,
  INBOUND_DISCOVERY,
  invitePeer,
  rotateCredentials,
} from "@/lib/ocpi/handshake";
import { setPeerStoreForTests } from "@/lib/ocpi/registry";
import { MAX_REQUEST_BYTES } from "@/lib/ocpi/server";
import { MemoryPeerStore } from "@/lib/ocpi/store";
import { authorizationHeader } from "@/lib/ocpi/tokens";
import { configErrors } from "@/lib/server/config";
import {
  isPublicAddress,
  PeerAddressError,
  peerFetch,
  setPeerNetworkForTests,
  type ResolvedAddress,
} from "@/lib/server/peer-fetch";
import {
  emspHandler,
  FAKE_PUBLIC_ADDRESS,
  inProcessNetwork,
  LIVE_ENV,
} from "./support/network";

/**
 * Peers choose the URLs this server calls. These tests pin down that a peer cannot
 * point those calls at this server's own network (SSRF), cannot learn anything about
 * other hosts from our answers, and cannot make us buffer unbounded bodies.
 */

const EMSP_CREDENTIALS = "https://emsp.example.test/ocpi/2.2.1/credentials";
const saved = { ...process.env };
const sleep = vi.fn(async () => {});
const client: ClientOptions = { sleep };

let store: MemoryPeerStore;
let cpo: MockCpo;
let net: ReturnType<typeof inProcessNetwork>;
/** Fake DNS: host -> addresses. Unlisted hosts get a public address. */
let dns: Record<string, ResolvedAddress[]>;
const resolve = vi.fn(
  async (host: string) =>
    dns[host] ?? [{ address: FAKE_PUBLIC_ADDRESS, family: 4 }],
);
/** Replaces the PUT credentials reply of the mock CPO, when set. */
let rewritePut: ((body: Record<string, unknown>) => unknown) | undefined;

beforeEach(() => {
  Object.assign(process.env, LIVE_ENV);
  delete process.env.DEMO_MODE;
  delete process.env.OCPI_ALLOW_PRIVATE_PEERS;
  store = new MemoryPeerStore();
  setPeerStoreForTests(store);
  dns = {};
  rewritePut = undefined;
  resolve.mockClear();
  net = inProcessNetwork({
    "emsp.example.test": emspHandler,
    "mock-cpo.example.test": async (r) => {
      const res = await cpo.handle(r);
      if (!rewritePut || r.method !== "PUT") return res;
      return Response.json(rewritePut(await res.json()));
    },
    // A server on "the inside" that a peer would like us to read.
    "internal.example.test": async () =>
      Response.json(
        {
          status_code: 3000,
          status_message: "internal-admin-panel v1.2 db=replica",
          timestamp: "2026-01-01T00:00:00Z",
        },
        { status: 500 },
      ),
  });
  cpo = createMockCpo({ transport: net.transport });
  setPeerNetworkForTests({
    resolve,
    send: (url, init) => net.transport(url.toString(), init),
  });
});

afterEach(() => {
  setPeerNetworkForTests(undefined);
  setPeerStoreForTests(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe("peer addresses", () => {
  it("refuses loopback, private, link-local, CGNAT, ULA, metadata and other special addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "127.8.9.10",
      "0.0.0.0",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "[::1]",
      "fe80::1",
      "fe80::1%eth0",
      "fc00::1",
      "fd12:3456::1",
      "fd00:ec2::254",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:10.0.0.5",
      "::ffff:a9fe:a9fe",
      "64:ff9b::7f00:1",
      "2002:7f00:1::",
      "not-an-ip",
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
  });

  it("allows public addresses", () => {
    for (const ip of [
      FAKE_PUBLIC_ADDRESS,
      "8.8.8.8",
      "172.32.0.1",
      "100.128.0.1",
      "2606:4700::1111",
      "::ffff:93.184.215.14",
    ])
      expect(isPublicAddress(ip), ip).toBe(true);
  });
});

describe("peerFetch", () => {
  const send = vi.fn(async () => new Response("ok"));
  beforeEach(() => {
    send.mockClear();
    setPeerNetworkForTests({ resolve, send });
  });

  it("refuses IP literals that are not public, without DNS or a connection", async () => {
    for (const url of [
      "https://127.0.0.1:8443/internal/admin",
      "https://[::1]/ocpi/versions",
      "https://10.0.0.5/ocpi/versions",
      "https://192.168.1.1/ocpi/versions",
      "https://169.254.169.254/latest/meta-data/",
      "https://[fd00:ec2::254]/latest/meta-data/",
      "https://[::ffff:127.0.0.1]/",
      "https://2130706433/", // 127.0.0.1 written as one number
      "https://0x7f.1/",
    ])
      await expect(peerFetch(url), url).rejects.toBeInstanceOf(
        PeerAddressError,
      );
    expect(resolve).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a host name that resolves to a private address (DNS rebinding)", async () => {
    dns["rebind.example.test"] = [{ address: "10.0.0.5", family: 4 }];
    dns["mixed.example.test"] = [
      { address: FAKE_PUBLIC_ADDRESS, family: 4 },
      { address: "::1", family: 6 },
    ];
    dns["localhost"] = [{ address: "127.0.0.1", family: 4 }];
    for (const host of [
      "rebind.example.test",
      "mixed.example.test",
      "localhost",
    ])
      await expect(peerFetch(`https://${host}/ocpi/versions`)).rejects.toThrow(
        /not a public address/,
      );
    expect(send).not.toHaveBeenCalled();
  });

  it("resolves once and connects to the address it checked", async () => {
    await peerFetch("https://cpo.example.test/ocpi/versions");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0] as unknown[])[2]).toEqual({
      address: FAKE_PUBLIC_ADDRESS,
      family: 4,
    });
  });

  it("refuses http:// and URLs with credentials", async () => {
    for (const url of [
      "http://cpo.example.test/ocpi/versions",
      "https://user:pw@cpo.example.test/ocpi/versions",
    ])
      await expect(peerFetch(url)).rejects.toBeInstanceOf(PeerAddressError);
    expect(send).not.toHaveBeenCalled();
  });

  it("allows private peers only with OCPI_ALLOW_PRIVATE_PEERS=1, and never in production", async () => {
    dns["dev-cpo.example.test"] = [{ address: "127.0.0.1", family: 4 }];
    process.env.OCPI_ALLOW_PRIVATE_PEERS = "1";
    await expect(
      peerFetch("https://dev-cpo.example.test/ocpi/versions"),
    ).resolves.toBeInstanceOf(Response);
    vi.stubEnv("NODE_ENV", "production");
    await expect(
      peerFetch("https://dev-cpo.example.test/ocpi/versions"),
    ).rejects.toBeInstanceOf(PeerAddressError);
    vi.unstubAllEnvs();
  });

  it("the real socket connects to the pinned address, not a new DNS answer", async () => {
    // A local TCP listener stands in for "whatever the checked address is". The host
    // name is not in any DNS; only the pinned lookup can bring the socket here.
    const seen: Buffer[] = [];
    const sockets: Socket[] = [];
    const server = createServer((s) => {
      sockets.push(s);
      s.once("data", (d) => {
        seen.push(Buffer.from(d));
        s.destroy();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    process.env.OCPI_ALLOW_PRIVATE_PEERS = "1";
    dns["pinned.example.test"] = [{ address: "127.0.0.1", family: 4 }];
    setPeerNetworkForTests({ resolve });
    try {
      await expect(
        peerFetch(`https://pinned.example.test:${port}/ocpi/versions`),
      ).rejects.toThrow();
      // The TLS ClientHello arrived, with the host name for certificate checks (SNI).
      expect(seen).toHaveLength(1);
      expect(seen[0].includes(Buffer.from("pinned.example.test"))).toBe(true);
      expect(resolve).toHaveBeenCalledTimes(1);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    }
  });
});

describe("a peer cannot use us to reach other hosts", () => {
  const credentialsPost = async (url: string, token = "cpo-token-b") => {
    const { peer, tokenA } = await invitePeer({ label: "Peer" }, { store });
    const body = {
      token,
      url,
      roles: [
        {
          role: "CPO",
          party_id: "PRB",
          country_code: "ZZ",
          business_details: { name: "Probe" },
        },
      ],
    };
    const res = await net.transport(EMSP_CREDENTIALS, {
      method: "POST",
      headers: {
        Authorization: authorizationHeader(tokenA),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { peer, res, json: await res.json() };
  };

  it("answers one generic error for private, unresolvable, failing and non-OCPI targets", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dns["rebind.example.test"] = [{ address: "192.168.1.1", family: 4 }];
    const answers = [];
    for (const url of [
      "https://127.0.0.1:8443/internal/admin",
      "https://10.0.0.5/ocpi/versions",
      "https://192.168.1.1/ocpi/versions",
      "https://[::1]/ocpi/versions",
      "https://rebind.example.test/ocpi/versions",
      "https://internal.example.test/ocpi/versions",
      "https://nowhere.example.test/ocpi/versions",
    ]) {
      const { peer, res, json } = await credentialsPost(url, "secret-token-b");
      answers.push({
        http: res.status,
        code: json.status_code,
        message: json.status_message,
      });
      expect((await store.getPeer(peer.id))!.status).toBe("pending");
    }
    // Every target looks the same from outside: no port scan, no echoed body.
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]).toEqual({
      http: 400,
      code: 3001,
      message: "Peer endpoint unreachable or invalid",
    });
    // Nothing reached the private addresses; the internal host was tried once only.
    const hosts = net.calls.map((c) => new URL(c.url).hostname);
    for (const h of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "[::1]"])
      expect(hosts).not.toContain(h);
    expect(hosts.filter((h) => h === "internal.example.test")).toHaveLength(1);
    // The details are logged on our side, without the peer's token.
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/internal-admin-panel/);
    expect(logged).toMatch(/not a public address/);
    expect(logged).not.toContain("secret-token-b");
  });

  it("does the same for a registered peer's credentials PUT", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const invite = await invitePeer({ label: "Mock CPO" }, { store });
    await cpo.registerWith(invite.versionsUrl, invite.tokenA);
    const tokenC = cpo.state.emsp!.token;
    const res = await net.transport(EMSP_CREDENTIALS, {
      method: "PUT",
      headers: {
        Authorization: authorizationHeader(tokenC),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...cpo.state.emsp!.credentials,
        token: "new-token",
        url: "https://169.254.169.254/latest/meta-data/",
        roles: [
          {
            role: "CPO",
            party_id: "MCK",
            country_code: "ZZ",
            business_details: { name: "Mock CPO" },
          },
        ],
      }),
    });
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json).toMatchObject({
      status_code: 3001,
      status_message: "Peer endpoint unreachable or invalid",
    });
    // The old token still works: nothing changed.
    expect(
      (
        await ocpiRequest(
          { url: invite.versionsUrl, token: tokenC },
          { transport: net.transport, retries: 0 },
        )
      ).statusCode,
    ).toBe(1000);
  });

  it("discovers a calling peer with one short try", () => {
    expect(INBOUND_DISCOVERY).toEqual({ retries: 0, timeoutMs: 5_000 });
  });

  it("tells an admin why a versions URL was refused", async () => {
    await expect(
      connectToCpo(
        {
          label: "Inside",
          versionsUrl: "https://10.0.0.5/ocpi/versions",
          tokenA: "token-a",
        },
        { store, client },
      ),
    ).rejects.toThrow(/not a public address/);
    expect(store.peers.size).toBe(0);
  });
});

describe("body size limits", () => {
  it("refuses a response whose Content-Length is over 1 MB without reading it", async () => {
    let pulled = 0;
    const body = new ReadableStream({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(1024));
      },
    });
    const transport = async () =>
      new Response(body, {
        headers: { "Content-Length": String(MAX_RESPONSE_BYTES + 1) },
      });
    await expect(
      ocpiRequest(
        { url: "https://cpo.example.test/ocpi/versions", token: "t" },
        { transport, retries: 0 },
      ),
    ).rejects.toThrow(/too large a body/);
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it("stops reading a streamed response at 1 MB", async () => {
    let sent = 0;
    const body = new ReadableStream({
      pull(c) {
        sent += 64 * 1024;
        c.enqueue(new Uint8Array(64 * 1024));
      },
    });
    await expect(
      ocpiRequest(
        { url: "https://cpo.example.test/ocpi/versions", token: "t" },
        { transport: async () => new Response(body), retries: 0 },
      ),
    ).rejects.toThrow(/too large a body/);
    expect(sent).toBeLessThan(MAX_RESPONSE_BYTES + 256 * 1024);
  });

  it("answers 413 to a request over 256 KB, by Content-Length or by stream", async () => {
    const { tokenA } = await invitePeer({ label: "Peer" }, { store });
    const headers = {
      Authorization: authorizationHeader(tokenA),
      "Content-Type": "application/json",
    };
    const declared = await emspHandler(
      new Request(EMSP_CREDENTIALS, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Length": String(MAX_REQUEST_BYTES + 1),
        },
        body: "{}",
      }),
    );
    expect(declared.status).toBe(413);
    let sent = 0;
    const streamed = await emspHandler(
      new Request(EMSP_CREDENTIALS, {
        method: "POST",
        headers,
        body: new ReadableStream({
          pull(c) {
            sent += 32 * 1024;
            c.enqueue(new TextEncoder().encode(" ".repeat(32 * 1024)));
          },
        }),
        duplex: "half",
      } as RequestInit),
    );
    expect(streamed.status).toBe(413);
    expect(sent).toBeLessThan(MAX_REQUEST_BYTES + 128 * 1024);
  });
});

describe("Token A expiry", () => {
  it("expires after 7 days by default, or OCPI_TOKEN_A_TTL_DAYS", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T00:00:00Z"));
    const week = await invitePeer({ label: "A" }, { store });
    expect(week.expiresAt).toBe("2026-10-28T00:00:00.000Z");
    process.env.OCPI_TOKEN_A_TTL_DAYS = "1";
    const day = await invitePeer({ label: "B" }, { store });
    expect(day.expiresAt).toBe("2026-10-22T00:00:00.000Z");

    const call = (token: string) =>
      ocpiRequest(
        { url: week.versionsUrl, token },
        { transport: net.transport, retries: 0 },
      );
    vi.setSystemTime(new Date("2026-10-21T23:59:00Z"));
    expect((await call(day.tokenA)).statusCode).toBe(1000);
    vi.setSystemTime(new Date("2026-10-22T00:00:01Z"));
    await expect(call(day.tokenA)).rejects.toMatchObject({ httpStatus: 401 });
    expect((await call(week.tokenA)).statusCode).toBe(1000);
    vi.setSystemTime(new Date("2026-10-28T00:00:01Z"));
    await expect(call(week.tokenA)).rejects.toMatchObject({ httpStatus: 401 });
    // A CPO that registered in time keeps working: B and C do not expire.
  });

  it("reports an invalid OCPI_TOKEN_A_TTL_DAYS", () => {
    for (const v of ["0", "91", "7.5", "week"]) {
      process.env.OCPI_TOKEN_A_TTL_DAYS = v;
      expect(configErrors()).toContain(
        "OCPI_TOKEN_A_TTL_DAYS must be a whole number of days, 1 to 90",
      );
    }
  });
});

describe("rotation checks the new roles", () => {
  it("keeps the old roles, but stores the new token, when the CPO now claims our party", async () => {
    const tokenA = cpo.issueTokenA();
    const peer = await connectToCpo(
      { label: "Mock CPO", versionsUrl: cpo.urls.versions, tokenA },
      { store, client },
    );
    const before = peer.tokenCiphertext;
    rewritePut = (body) => {
      const data = body.data as { roles: Record<string, unknown>[] };
      data.roles = [{ ...data.roles[0], country_code: "NL", party_id: "ABC" }];
      return body;
    };
    const err = await rotateCredentials(peer.id, { store, client }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(HandshakeError);
    expect(err.message).toMatch(/new roles were refused/);
    const after = (await store.getPeer(peer.id))!;
    expect(after.status).toBe("registered");
    expect(after.roles).toEqual(peer.roles);
    expect(after.tokenCiphertext).not.toBe(before);
  });
});
