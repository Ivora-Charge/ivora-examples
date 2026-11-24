import dns from "node:dns";
import { lookup as promisesLookup } from "node:dns/promises";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { expectRefusals } from "./support/no-network";

// The guard in tests/support/no-network.ts (a setup file of every unit test).
describe("no real network in unit tests", () => {
  // These tests refuse on purpose: clear what the guard recorded.
  afterEach(() => {
    expectRefusals();
  });

  it("refuses a fetch of a remote host", async () => {
    await expect(fetch("https://db.example.test/rest/v1/x")).rejects.toThrow(
      /Real network use/,
    );
  });

  it("refuses a DNS lookup of a remote host", async () => {
    const err = await new Promise<Error | null>((resolve) =>
      dns.lookup("db.example.test", (e) => resolve(e)),
    );
    expect(err?.message).toMatch(/Real network use/);
  });

  it("refuses dns.promises.lookup and the node:dns/promises export (peer-fetch)", async () => {
    await expect(dns.promises.lookup("db.example.test")).rejects.toThrow(
      /Real network use/,
    );
    await expect(
      promisesLookup("db.example.test", { all: true, verbatim: true }),
    ).rejects.toThrow(/Real network use/);
    expect(expectRefusals()).toBe(2);
  });

  it.each([
    "resolve",
    "resolve4",
    "resolve6",
    "resolveAny",
    "resolveCname",
    "resolveMx",
    "resolveSrv",
    "resolveTxt",
  ] as const)(
    "refuses dns.%s, its promise form and a Resolver's",
    async (name) => {
      const err = await new Promise<Error | null>((resolve) =>
        (dns[name] as (h: string, cb: (e: Error | null) => void) => void)(
          "db.example.test",
          (e) => resolve(e),
        ),
      );
      expect(err?.message).toMatch(/Real network use/);
      await expect(dns.promises[name]("db.example.test")).rejects.toThrow(
        /Real network use/,
      );
      await expect(
        new dns.promises.Resolver()[name]("db.example.test"),
      ).rejects.toThrow(/Real network use/);
      const viaResolver = await new Promise<Error | null>((resolve) =>
        (
          new dns.Resolver()[name] as (
            h: string,
            cb: (e: Error | null) => void,
          ) => void
        )("db.example.test", (e) => resolve(e)),
      );
      expect(viaResolver?.message).toMatch(/Real network use/);
      expect(expectRefusals()).toBe(4);
    },
  );

  it("refuses dns.reverse", async () => {
    await expect(dns.promises.reverse("192.0.2.1")).rejects.toThrow(
      /Real network use/,
    );
  });

  it("treats only localhost and 127.0.0.0/8 literals as local", async () => {
    await expect(fetch("http://127.example.test/")).rejects.toThrow(
      /Real network use/,
    );
    await expect(dns.promises.lookup("127.example.test")).rejects.toThrow(
      /Real network use/,
    );
    await expect(dns.promises.lookup("0.0.0.0")).rejects.toThrow(
      /Real network use/,
    );
    expect(expectRefusals()).toBe(3);
    expect((await dns.promises.lookup("127.0.0.2")).address).toBe("127.0.0.2");
    expect((await dns.promises.lookup("localhost")).address).toBeTruthy();
  });

  it("refuses a TCP connect to a remote host", async () => {
    const err = await new Promise<Error>((resolve) => {
      const socket = net.connect({ host: "db.example.test", port: 5432 });
      socket.on("error", resolve);
    });
    expect(err.message).toMatch(/Real network use/);
  });

  it("still allows localhost", async () => {
    const server = net.createServer((s) => s.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as net.AddressInfo;
    const data = await new Promise<string>((resolve, reject) => {
      const s = net.connect({ host: "127.0.0.1", port });
      let out = "";
      s.on("data", (d) => (out += d)).on("end", () => resolve(out));
      s.on("error", reject);
    });
    server.close();
    expect(data).toBe("ok");
  });
});
