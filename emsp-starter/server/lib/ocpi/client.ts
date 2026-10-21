import "server-only";
import { randomUUID } from "node:crypto";
import { peerFetch } from "@/lib/server/peer-fetch";
import { BodyTooLargeError, readLimitedText } from "./body";
import {
  errorClassFor,
  OcpiClientError,
  isSuccess,
  OcpiError,
  OcpiTransportError,
  OcpiUnauthorizedError,
} from "./errors";
import { parseEnvelope } from "./schema";
import { authorizationHeader } from "./tokens";
import type { Party } from "./types";

/**
 * The OCPI client: every request this eMSP (or the mock CPO) makes to a peer.
 *
 * - Sends `Authorization: Token <base64>`, a new X-Request-ID per attempt and one
 *   X-Correlation-ID per call, and the routing headers when `routing` is given.
 * - Checks the response envelope and maps OCPI status codes to errors (errors.ts).
 * - Retries timeouts, network errors and HTTP 5xx with exponential backoff and jitter.
 *   Only GET is retried unless `retry: true`: a repeated POST or PUT to the credentials
 *   module would not be safe.
 * - Never follows redirects, so a token is never sent to a host nobody configured.
 * - Reads at most 1 MB of a response.
 * - The default transport, `peerFetch`, refuses hosts that are not public addresses.
 */

/** Sends one HTTP request. Defaults to `peerFetch`: demo-mode gate and address check. */
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export type ClientOptions = {
  transport?: Transport;
  /** Per attempt. Default 15 s. */
  timeoutMs?: number;
  /** Retries after the first attempt. Default 3. */
  retries?: number;
  /** First backoff delay; doubles each retry up to maxDelayMs. Default 250 ms. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

export type OcpiRequest = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  /** The token the peer gave us. Encoded into the Authorization header. */
  token: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Routing headers. Not used by the versions and credentials modules. */
  routing?: { from: Party; to: Party };
  correlationId?: string;
  /** Retry this non-GET request too. Only for requests that are safe to repeat. */
  retry?: boolean;
};

export type OcpiResult = {
  data: unknown;
  statusCode: number;
  statusMessage?: string;
  headers: Headers;
  correlationId: string;
};

/** The largest OCPI response we read. A page of objects stays well under it. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;
const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `GET host/path`: for messages and logs, without query string or credentials. */
function describe(method: string, url: URL): string {
  return `${method} ${url.host}${url.pathname}`;
}

/** A peer's status_message, shortened and stripped of control characters. */
function peerMessage(m: string | undefined): string {
  if (!m) return "";
  const clean = m.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  return clean ? `: ${clean.slice(0, 200)}` : "";
}

class Retryable extends Error {
  constructor(readonly error: OcpiError) {
    super(error.message);
  }
}

export async function ocpiRequest(
  req: OcpiRequest,
  opts: ClientOptions = {},
): Promise<OcpiResult> {
  const method = req.method ?? "GET";
  const url = new URL(req.url);
  for (const [k, v] of Object.entries(req.query ?? {}))
    if (v !== undefined) url.searchParams.set(k, String(v));
  const what = describe(method, url);
  const correlationId = req.correlationId ?? randomUUID();
  const retries = method === "GET" || req.retry ? (opts.retries ?? 3) : 0;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const base = opts.baseDelayMs ?? 250;
  const max = opts.maxDelayMs ?? 4000;

  for (let attempt = 0; ; attempt++) {
    try {
      return await attemptOnce(req, method, url, what, correlationId, opts);
    } catch (e) {
      if (!(e instanceof Retryable)) throw e;
      if (attempt >= retries) throw e.error;
      const delay = Math.min(max, base * 2 ** attempt);
      await sleep(Math.round(delay / 2 + (random() * delay) / 2));
    }
  }
}

async function attemptOnce(
  req: OcpiRequest,
  method: string,
  url: URL,
  what: string,
  correlationId: string,
  opts: ClientOptions,
): Promise<OcpiResult> {
  const headers: Record<string, string> = {
    Authorization: authorizationHeader(req.token),
    Accept: "application/json",
    "X-Request-ID": randomUUID(),
    "X-Correlation-ID": correlationId,
  };
  if (req.body !== undefined) headers["Content-Type"] = "application/json";
  if (req.routing) {
    headers["OCPI-from-country-code"] = req.routing.from.countryCode;
    headers["OCPI-from-party-id"] = req.routing.from.partyId;
    headers["OCPI-to-country-code"] = req.routing.to.countryCode;
    headers["OCPI-to-party-id"] = req.routing.to.partyId;
  }
  const transport = opts.transport ?? peerFetch;

  let res: Response;
  let text: string;
  // A timer rather than AbortSignal.timeout(), which only holds its signal weakly.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("Timed out", "TimeoutError")),
    opts.timeoutMs ?? 15_000,
  );
  try {
    res = await transport(url.toString(), {
      method,
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      redirect: "error",
      signal: controller.signal,
    });
    text = await readLimitedText(res, MAX_RESPONSE_BYTES);
  } catch (e) {
    // Demo mode and other deliberate refusals are not network trouble: never retry them.
    if (e instanceof Error && "code" in e && e.code === "demo_mode") throw e;
    if (e instanceof Error && "code" in e && e.code === "peer_address_refused")
      throw new OcpiTransportError(`${what} refused: ${e.message}`, {
        request: what,
      });
    if (e instanceof BodyTooLargeError)
      throw new OcpiTransportError(`${what} returned too large a body`, {
        request: what,
      });
    const timeout =
      e instanceof Error &&
      (e.name === "TimeoutError" || e.name === "AbortError");
    throw new Retryable(
      new OcpiTransportError(
        `${what} ${timeout ? "timed out" : "failed: no response"}`,
        { request: what },
      ),
    );
  } finally {
    clearTimeout(timer);
  }

  const fail = (Kind: typeof OcpiError, message: string, statusCode?: number) =>
    new Kind(message, { request: what, httpStatus: res.status, statusCode });

  if (res.status >= 300 && res.status < 400)
    throw fail(OcpiTransportError, `${what} answered with a redirect`);

  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {}
  const parsed = parseEnvelope(json);
  const envelope = parsed.ok ? parsed.value : undefined;

  if (res.status === 401 || res.status === 403)
    throw fail(
      OcpiUnauthorizedError,
      `${what} refused our token (HTTP ${res.status})${peerMessage(envelope?.status_message)}`,
      envelope?.status_code,
    );
  if (res.status >= 500) {
    const err = fail(
      envelope ? errorClassFor(envelope.status_code) : OcpiTransportError,
      `${what} failed with HTTP ${res.status}${envelope ? ` and OCPI status ${envelope.status_code}` : ""}${peerMessage(envelope?.status_message)}`,
      envelope?.status_code,
    );
    throw new Retryable(err);
  }
  if (!envelope)
    throw fail(
      OcpiTransportError,
      `${what} returned HTTP ${res.status} without an OCPI response body`,
    );
  if (!isSuccess(envelope.status_code) || !res.ok)
    throw fail(
      // A success code with an HTTP 4xx is still a refused request.
      isSuccess(envelope.status_code)
        ? OcpiClientError
        : errorClassFor(envelope.status_code),
      `${what} failed with OCPI status ${envelope.status_code} (HTTP ${res.status})${peerMessage(envelope.status_message)}`,
      envelope.status_code,
    );
  return {
    data: envelope.data,
    statusCode: envelope.status_code,
    statusMessage: envelope.status_message,
    headers: res.headers,
    correlationId,
  };
}

export type Page = {
  items: unknown[];
  /** X-Total-Count: objects available on the server, across all pages. */
  totalCount?: number;
  /** X-Limit: the most objects the server returns per page. */
  limit?: number;
};

export type PageRequest = Omit<OcpiRequest, "method" | "body" | "retry"> & {
  limit?: number;
  offset?: number;
  dateFrom?: Date | string;
  dateTo?: Date | string;
  /** Stop after this many pages. Default 1000. */
  maxPages?: number;
};

const dateParam = (d: Date | string | undefined) =>
  d === undefined
    ? undefined
    : (typeof d === "string" ? new Date(d) : d)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z");

/** The `rel="next"` target of a Link header. */
export function nextLink(header: string | null): string | undefined {
  for (const part of header?.split(",") ?? []) {
    const m = /^\s*<([^>]+)>\s*;(.*)$/.exec(part);
    if (m && /\brel\s*=\s*"?next"?/i.test(m[2])) return m[1];
  }
  return undefined;
}

const headerInt = (h: Headers, name: string) => {
  const v = h.get(name);
  return v && /^\d+$/.test(v) ? Number(v) : undefined;
};

/**
 * Pages of a paginated OCPI GET (locations, tariffs, sessions, CDRs, ...). Follows the
 * Link header until there is no next page. The next URL must stay on the same origin
 * as the first one: our token never goes anywhere else.
 */
export async function* ocpiPages(
  req: PageRequest,
  opts: ClientOptions = {},
): AsyncGenerator<Page> {
  const { limit, offset, dateFrom, dateTo, maxPages = 1000, ...rest } = req;
  const first = new URL(req.url);
  const correlationId = req.correlationId ?? randomUUID();
  let url: string | undefined = req.url;
  let query: OcpiRequest["query"] = {
    ...req.query,
    offset,
    limit,
    date_from: dateParam(dateFrom),
    date_to: dateParam(dateTo),
  };
  const seen = new Set<string>();
  for (let page = 0; url; page++) {
    if (page >= maxPages)
      throw new OcpiTransportError(
        `${describe("GET", first)} has more than ${maxPages} pages`,
        { request: describe("GET", first) },
      );
    const res = await ocpiRequest(
      { ...rest, url, query, correlationId, method: "GET" },
      opts,
    );
    if (!Array.isArray(res.data))
      throw new OcpiTransportError(
        `${describe("GET", first)} returned a page that is not a list`,
        { request: describe("GET", first) },
      );
    yield {
      items: res.data,
      totalCount: headerInt(res.headers, "X-Total-Count"),
      limit: headerInt(res.headers, "X-Limit"),
    };
    const next = nextLink(res.headers.get("Link"));
    if (!next) return;
    let nextUrl: URL;
    try {
      nextUrl = new URL(next, first);
    } catch {
      nextUrl = new URL("invalid:");
    }
    if (nextUrl.origin !== first.origin || nextUrl.protocol !== first.protocol)
      throw new OcpiTransportError(
        `${describe("GET", first)} linked its next page to another origin; not followed`,
        { request: describe("GET", first) },
      );
    if (seen.has(nextUrl.href))
      throw new OcpiTransportError(
        `${describe("GET", first)} linked back to a page it already returned`,
        { request: describe("GET", first) },
      );
    seen.add(nextUrl.href);
    url = nextUrl.href;
    // The next link carries its own offset, limit and date filters.
    query = undefined;
  }
}

/** Every object of a paginated OCPI GET, one at a time. */
export async function* ocpiPaginate(
  req: PageRequest,
  opts: ClientOptions = {},
): AsyncGenerator<unknown> {
  for await (const page of ocpiPages(req, opts)) yield* page.items;
}
