import dns from "node:dns";
import net from "node:net";
import { afterEach } from "vitest";

// Unit tests never use the real network. A request to a host that is not this machine
// (DNS lookup, TCP connect, fetch) throws at once, so the test fails where it happened
// instead of flaking on a slow or blocked network. Connections to localhost stay open
// for tests that start their own server.

const isLocal = (host: unknown) =>
  typeof host !== "string" ||
  host === "localhost" ||
  host === "::1" ||
  host === "::" ||
  host.startsWith("127.") ||
  host === "0.0.0.0";

// Code under test often catches and logs an error, so a refusal is also recorded and
// fails the test in afterEach, caught or not. `expectRefusals` is for the guard's own test.
const refused: string[] = [];
export const expectRefusals = () => refused.splice(0).length;

const refuse = (what: string, host: unknown) => {
  const message = `Real network use in a unit test (${what} ${String(host)}). Stub the network instead.`;
  refused.push(message);
  return new Error(message);
};

afterEach(() => {
  const found = refused.splice(0);
  if (found.length) throw new Error(found.join("\n"));
});

const realLookup = dns.lookup;
// Assigned, not spied: a test's vi.restoreAllMocks() must not lift the guard.
dns.lookup = ((host: string, ...args: unknown[]) => {
  if (isLocal(host))
    return (realLookup as (...a: unknown[]) => unknown)(host, ...args);
  const cb = args.find((a) => typeof a === "function") as
    ((e: Error) => void) | undefined;
  const err = refuse("DNS lookup of", host);
  if (cb) process.nextTick(cb, err);
  else throw err;
}) as typeof dns.lookup;

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const first = args[0] as { host?: string; path?: string } | number | string;
  const host =
    typeof first === "object" && first !== null
      ? first.path
        ? undefined
        : first.host
      : typeof args[1] === "string"
        ? args[1]
        : undefined;
  // A caller's own `lookup` picks the address (the pinned lookup of peer-fetch); the
  // real dns.lookup stays guarded above.
  const ownLookup =
    typeof first === "object" && first !== null && "lookup" in first;
  if (!ownLookup && !isLocal(host)) {
    const err = refuse("connect to", host);
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  if (!isLocal(url.hostname.replace(/^\[|\]$/g, "")))
    throw refuse("fetch of", url.host);
  return realFetch(input, init);
}) as typeof fetch;
