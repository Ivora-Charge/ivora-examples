import "server-only";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { assertLive } from "./demo";

/**
 * Outbound requests to OCPI peers. Peers choose the URLs we call (versions, version
 * details, every module endpoint), so a request to a peer must never reach this
 * server's own network: loopback, private ranges, link-local, cloud metadata and so on.
 *
 * - Refused in demo mode, through `assertLive` (demo.ts), before anything is resolved.
 * - https only. The host is resolved once; if any of its addresses is not public the
 *   request is refused. The socket then connects to that checked address (a pinned
 *   lookup), so a second DNS answer cannot point it elsewhere (DNS rebinding).
 * - IP literals are checked the same way.
 * - Never follows redirects.
 *
 * OCPI_ALLOW_PRIVATE_PEERS=1 skips the address check, for local development and tests
 * with a CPO on this machine or network. It is ignored when NODE_ENV is production.
 */

/** A peer URL that points somewhere this server must not call. */
export class PeerAddressError extends Error {
  readonly code = "peer_address_refused";
  constructor(message: string) {
    super(message);
    this.name = "PeerAddressError";
  }
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network", unspecified
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and broadcast
] as const)
  blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["::", 96], // IPv4-compatible (deprecated)
  ["64:ff9b::", 96], // NAT64: embeds an IPv4 address
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 32], // Teredo: embeds an IPv4 address
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4: embeds an IPv4 address
  ["fc00::", 7], // unique local, including fd00:ec2::254 (cloud metadata)
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const)
  blocked.addSubnet(net, prefix, "ipv6");

/**
 * True when `address` is an IP this server may connect to for a peer. IPv4-mapped IPv6
 * addresses (::ffff:a.b.c.d) are checked as IPv4.
 */
export function isPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(ip);
  if (family === 4) return !blocked.check(ip, "ipv4");
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return isPublicAddress(mapped[1]);
    return !blocked.check(ip, "ipv6");
  }
  return false;
}

export type ResolvedAddress = { address: string; family: number };

/** Resolves a host name to every address. Replaceable in tests. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

/** Sends a request to a host whose address is already checked. Replaceable in tests. */
export type PinnedSend = (
  url: URL,
  init: RequestInit,
  pinned: ResolvedAddress,
) => Promise<Response>;

const systemResolver: Resolver = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

/** Whether OCPI_ALLOW_PRIVATE_PEERS is on, and allowed to be. */
export function privatePeersAllowed(): boolean {
  return (
    process.env.OCPI_ALLOW_PRIVATE_PEERS?.trim() === "1" &&
    process.env.NODE_ENV !== "production"
  );
}

/** The address to connect to for `url`, checked unless private peers are allowed. */
export async function resolvePeerHost(
  url: URL,
  resolve: Resolver = systemResolver,
): Promise<ResolvedAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const check = !privatePeersAllowed();
  const literal = isIP(host);
  const addresses = literal
    ? [{ address: host, family: literal }]
    : await resolve(host).catch(() => {
        throw new PeerAddressError(`${url.host} could not be resolved`);
      });
  if (addresses.length === 0)
    throw new PeerAddressError(`${url.host} could not be resolved`);
  // Every address must be public: a host with one private answer is refused.
  if (check && addresses.some((a) => !isPublicAddress(a.address)))
    throw new PeerAddressError(`${url.host} is not a public address`);
  return addresses[0];
}

/** HTTPS request to the pinned address, as a fetch Response. Certificates are checked against the host name. */
const httpsSend: PinnedSend = (url, init, pinned) =>
  new Promise<Response>((resolve, reject) => {
    const lookup: LookupFunction = (_host, options, callback) => {
      if (options.all)
        (callback as (e: null, a: ResolvedAddress[]) => void)(null, [pinned]);
      else callback(null, pinned.address, pinned.family);
    };
    const headers = new Headers(init.headers);
    const req = httpsRequest(
      url,
      {
        method: init.method ?? "GET",
        headers: Object.fromEntries(headers.entries()),
        lookup,
        signal: init.signal ?? undefined,
        // A fresh connection per request: a pooled socket could predate the check.
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status > 599) {
          res.destroy();
          reject(new TypeError("fetch failed: unexpected HTTP status"));
          return;
        }
        const resHeaders = new Headers();
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
          try {
            resHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
          } catch {}
        }
        const noBody = status === 204 || status === 205 || status === 304;
        if (noBody) res.resume();
        resolve(
          new Response(
            noBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>),
            { status, statusText: res.statusMessage, headers: resHeaders },
          ),
        );
      },
    );
    req.on("error", (e) => reject(e));
    if (typeof init.body === "string") req.end(init.body);
    else req.end();
  });

let override: { resolve?: Resolver; send?: PinnedSend } | undefined;

/** Tests replace DNS and the socket with in-process fakes. */
export function setPeerNetworkForTests(
  network: { resolve?: Resolver; send?: PinnedSend } | undefined,
) {
  override = network;
}

/** The only way to send a request to an OCPI peer. Refuses in demo mode. */
export async function peerFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const url = new URL(input);
  // Name the host only: paths and query strings may carry tokens.
  assertLive(`send a request to ${url.host}`);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new PeerAddressError(`${url.host} is not an https:// peer URL`);
  const pinned = await resolvePeerHost(url, override?.resolve);
  return (override?.send ?? httpsSend)(url, init, pinned);
}
