import dns from "node:dns";
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
