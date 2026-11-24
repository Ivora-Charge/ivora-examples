import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { afterEach } from "vitest";

// Unit tests never use the real network. A request to a host that is not this machine
// (DNS lookup, TCP connect, fetch) throws at once, so the test fails where it happened
// instead of flaking on a slow or blocked network. Connections to localhost stay open
// for tests that start their own server.

// This machine only: "localhost" and loopback IP literals (127.0.0.0/8, ::1). A name
// that merely starts with "127." (127.example.test) is a remote host. A socket with no
// host (a Unix socket, or the default localhost) is local too.
const isLocal = (host: unknown) =>
  typeof host !== "string" ||
  host === "localhost" ||
  host === "::1" ||
  (net.isIPv4(host) && host.startsWith("127."));

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

type Fn = (...a: unknown[]) => unknown;
const lastCallback = (args: unknown[]) =>
  args.findLast((a) => typeof a === "function") as
    ((e: Error) => void) | undefined;

// Assigned, not spied: a test's vi.restoreAllMocks() must not lift the guard.
// dns.lookup and dns.lookupService (callback and promise forms) may ask for this
// machine; dns.resolve*, dns.reverse and a dns.Resolver always ask a DNS server, so
// they are refused for any name.
for (const api of [dns, dns.promises] as unknown as Record<string, Fn>[]) {
  const promises = api === (dns.promises as unknown);
  for (const name of Object.keys(api)) {
    const always = name.startsWith("resolve") || name === "reverse";
    if (!always && name !== "lookup" && name !== "lookupService") continue;
    if (typeof api[name] !== "function") continue;
    const real = api[name];
    api[name] = function (this: unknown, host: unknown, ...args: unknown[]) {
      if (!always && isLocal(host)) return real.call(this, host, ...args);
      const err = refuse(`dns.${promises ? "promises." : ""}${name} of`, host);
      if (promises) return Promise.reject(err);
      const cb = lastCallback(args);
      if (!cb) throw err;
      process.nextTick(cb, err);
    };
  }
}
for (const Resolver of [dns.Resolver, dns.promises.Resolver]) {
  const proto = Resolver.prototype as unknown as Record<string, Fn>;
  const promises = Resolver === dns.promises.Resolver;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (!name.startsWith("resolve") && name !== "reverse") continue;
    proto[name] = function (host: unknown, ...args: unknown[]) {
      const err = refuse(`dns Resolver.${name} of`, host);
      if (promises) return Promise.reject(err);
      const cb = lastCallback(args);
      if (!cb) throw err;
      process.nextTick(cb, err);
    };
  }
}
// Named ESM imports (`import { lookup } from "node:dns/promises"` in
// lib/server/peer-fetch.ts) follow the assignments above; syncing also covers code that
// Node itself loads as native ESM.
syncBuiltinESMExports();

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
