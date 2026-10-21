import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCpo } from "@/lib/mock-cpo";
import {
  nextLink,
  ocpiPages,
  ocpiPaginate,
  ocpiRequest,
  type Transport,
} from "@/lib/ocpi/client";
import {
  OcpiClientError,
  OcpiHubError,
  OcpiServerError,
  OcpiTransportError,
  OcpiUnauthorizedError,
} from "@/lib/ocpi/errors";
import { DemoModeError } from "@/lib/server/demo";
import { LIVE_ENV } from "./support/network";

const URL_ = "https://cpo.example.test/ocpi/2.2.1/locations";
const TOKEN = "secret-token-value";

const envelope = (body: Record<string, unknown>, init?: ResponseInit) =>
  Response.json({ timestamp: "2026-10-21T08:00:00Z", ...body }, init);

/** A transport that answers from a list, recording each request. */
function scripted(...replies: (Response | Error | "hang")[]) {
  const requests: Request[] = [];
  const transport: Transport = async (url, init) => {
    const request = new Request(url, init);
    requests.push(request);
    const next = replies.shift();
    if (next === "hang")
      return new Promise((_, reject) =>
        request.signal.addEventListener("abort", () =>
          reject(request.signal.reason),
        ),
      );
    if (next instanceof Error) throw next;
    if (!next) throw new Error("no more replies");
    return next;
  };
  return { transport, requests };
}

const sleep = vi.fn(async (_ms: number) => {});
const opts = (transport: Transport) => ({ transport, sleep, random: () => 1 });

beforeEach(() => sleep.mockClear());

describe("OCPI client", () => {
  it("sends the 2.2.1 headers and returns the data", async () => {
    const { transport, requests } = scripted(
      envelope({ data: [{ id: "1" }], status_code: 1000 }),
    );
    const res = await ocpiRequest(
      {
        url: URL_,
        token: TOKEN,
        query: { limit: 10 },
        routing: {
          from: { countryCode: "NL", partyId: "ABC" },
          to: { countryCode: "ZZ", partyId: "MCK" },
        },
        correlationId: "corr-1",
      },
      opts(transport),
    );
    expect(res.data).toEqual([{ id: "1" }]);
    const h = requests[0].headers;
    expect(h.get("authorization")).toBe(
      `Token ${Buffer.from(TOKEN).toString("base64")}`,
    );
    expect(h.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.get("x-correlation-id")).toBe("corr-1");
    expect(h.get("ocpi-from-country-code")).toBe("NL");
    expect(h.get("ocpi-from-party-id")).toBe("ABC");
    expect(h.get("ocpi-to-country-code")).toBe("ZZ");
    expect(h.get("ocpi-to-party-id")).toBe("MCK");
    expect(requests[0].url).toBe(`${URL_}?limit=10`);
  });

  it("sends JSON bodies and no routing headers when none are given", async () => {
    const { transport, requests } = scripted(
      envelope({ data: {}, status_code: 1000 }),
    );
    await ocpiRequest(
      { method: "PUT", url: URL_, token: TOKEN, body: { a: 1 } },
      opts(transport),
    );
    expect(requests[0].headers.get("content-type")).toBe("application/json");
    expect(await requests[0].json()).toEqual({ a: 1 });
    expect(requests[0].headers.has("ocpi-to-party-id")).toBe(false);
  });

  it("retries a GET on 5xx and network errors with exponential backoff", async () => {
    const { transport, requests } = scripted(
      envelope({ status_code: 3000 }, { status: 503 }),
      new TypeError("fetch failed"),
      new Response("Bad gateway", { status: 502 }),
      envelope({ data: [], status_code: 1000 }),
    );
    const res = await ocpiRequest(
      { url: URL_, token: TOKEN, correlationId: "c" },
      opts(transport),
    );
    expect(res.data).toEqual([]);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500, 1000]);
    // One correlation ID, a new request ID per attempt.
    expect(
      new Set(requests.map((r) => r.headers.get("x-correlation-id"))),
    ).toEqual(new Set(["c"]));
    expect(
      new Set(requests.map((r) => r.headers.get("x-request-id"))).size,
    ).toBe(4);
  });

  it("keeps the jittered delay between half and all of the backoff, capped", async () => {
    const { transport } = scripted(
      ...Array.from({ length: 6 }, () => new Response("", { status: 500 })),
    );
    await ocpiRequest(
      { url: URL_, token: TOKEN },
      { transport, sleep, random: () => 0, retries: 5, maxDelayMs: 1000 },
    ).catch(() => undefined);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([
      125, 250, 500, 500, 500,
    ]);
  });

  it("gives up after the retries with the last error", async () => {
    const { transport, requests } = scripted(
      ...Array.from({ length: 4 }, () =>
        envelope(
          { status_code: 3000, status_message: "down" },
          { status: 503 },
        ),
      ),
    );
    const err = await ocpiRequest(
      { url: URL_, token: TOKEN },
      opts(transport),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(OcpiServerError);
    expect(err).toMatchObject({ statusCode: 3000, httpStatus: 503 });
    expect(err.message).toBe(
      "GET cpo.example.test/ocpi/2.2.1/locations failed with HTTP 503 and OCPI status 3000: down",
    );
    expect(requests).toHaveLength(4);
  });

  it("does not retry a POST or PUT unless asked", async () => {
    const { transport, requests } = scripted(
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
      envelope({ status_code: 1000 }),
    );
    await expect(
      ocpiRequest(
        { method: "POST", url: URL_, token: TOKEN, body: {} },
        opts(transport),
      ),
    ).rejects.toBeInstanceOf(OcpiTransportError);
    expect(requests).toHaveLength(1);
    await ocpiRequest(
      { method: "PUT", url: URL_, token: TOKEN, body: {}, retry: true },
      opts(transport),
    );
    expect(requests).toHaveLength(3);
  });

  it("times out and retries a hanging request", async () => {
    const { transport, requests } = scripted(
      "hang",
      envelope({ data: "ok", status_code: 1000 }),
    );
    const res = await ocpiRequest(
      { url: URL_, token: TOKEN },
      { ...opts(transport), timeoutMs: 5 },
    );
    expect(res.data).toBe("ok");
    expect(requests).toHaveLength(2);

    const { transport: never } = scripted("hang");
    await expect(
      ocpiRequest(
        { url: URL_, token: TOKEN },
        { ...opts(never), timeoutMs: 5, retries: 0 },
      ),
    ).rejects.toThrow("GET cpo.example.test/ocpi/2.2.1/locations timed out");
  });

  it("maps OCPI status codes to errors, without retrying them", async () => {
    const cases = [
      [envelope({ status_code: 2001 }, { status: 400 }), OcpiClientError, 2001],
      [envelope({ status_code: 2004 }), OcpiClientError, 2004],
      [envelope({ status_code: 3001 }), OcpiServerError, 3001],
      [envelope({ status_code: 4001 }), OcpiHubError, 4001],
      [
        envelope({ status_code: 2000 }, { status: 401 }),
        OcpiUnauthorizedError,
        2000,
      ],
      [
        new Response("<html>", { status: 403 }),
        OcpiUnauthorizedError,
        undefined,
      ],
      [
        new Response("Not found", { status: 404 }),
        OcpiTransportError,
        undefined,
      ],
      [Response.json({ status_code: 1000 }), OcpiTransportError, undefined],
      [
        Response.json({ status_code: "1000", timestamp: "x" }),
        OcpiTransportError,
        undefined,
      ],
      // A success code on an HTTP error is still an error.
      [envelope({ status_code: 1000 }, { status: 400 }), OcpiClientError, 1000],
    ] as const;
    for (const [reply, Kind, code] of cases) {
      const { transport, requests } = scripted(reply);
      const err = await ocpiRequest(
        { url: URL_, token: TOKEN },
        opts(transport),
      ).catch((e) => e);
      expect(err).toBeInstanceOf(Kind);
      expect(err.statusCode).toBe(code);
      expect(requests).toHaveLength(1);
    }
  });

  it("never puts the token or the query string in an error", async () => {
    const { transport } = scripted(
      envelope(
        { status_code: 2001, status_message: "bad\nrequest" },
        { status: 400 },
      ),
    );
    const err = await ocpiRequest(
      { url: `${URL_}?secret=1`, token: TOKEN },
      opts(transport),
    ).catch((e) => e);
    expect(err.message).toBe(
      "GET cpo.example.test/ocpi/2.2.1/locations failed with OCPI status 2001 (HTTP 400): bad request",
    );
    expect(JSON.stringify({ ...err, message: err.message })).not.toContain(
      TOKEN,
    );
    expect(err.message).not.toContain(Buffer.from(TOKEN).toString("base64"));
  });

  it("does not follow redirects", async () => {
    const { transport, requests } = scripted(
      new Response(null, {
        status: 307,
        headers: { Location: "https://elsewhere.test/" },
      }),
    );
    await expect(
      ocpiRequest({ url: URL_, token: TOKEN }, opts(transport)),
    ).rejects.toThrow(/redirect/);
    expect(requests[0].redirect).toBe("error");
  });

  describe("in demo mode", () => {
    const saved = { ...process.env };
    afterEach(() => {
      process.env = { ...saved };
      vi.unstubAllGlobals();
    });

    it("refuses through outboundFetch, once, without touching fetch", async () => {
      process.env.DEMO_MODE = "true";
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      await expect(
        ocpiRequest({ url: URL_, token: TOKEN }, { sleep }),
      ).rejects.toBeInstanceOf(DemoModeError);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    });

    it("goes out through outboundFetch in live mode", async () => {
      Object.assign(process.env, LIVE_ENV);
      delete process.env.DEMO_MODE;
      const fetchSpy = vi.fn(async () =>
        envelope({ data: 1, status_code: 1000 }),
      );
      vi.stubGlobal("fetch", fetchSpy);
      expect(
        (await ocpiRequest({ url: URL_, token: TOKEN }, { sleep })).data,
      ).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });
});

describe("pagination", () => {
  it("parses Link headers", () => {
    expect(nextLink('<https://a.test/x?offset=2>; rel="next"')).toBe(
      "https://a.test/x?offset=2",
    );
    expect(
      nextLink('<https://a.test/p>; rel="prev", <https://a.test/n>; rel=next'),
    ).toBe("https://a.test/n");
    expect(nextLink(null)).toBeUndefined();
    expect(nextLink('<https://a.test/p>; rel="prev"')).toBeUndefined();
  });

  it("walks every page of the mock CPO's locations", async () => {
    const cpo = createMockCpo({
      transport: async () => {
        throw new Error("unused");
      },
    });
    // A registered eMSP's token at the mock CPO.
    cpo.state.issued.add("emsp-token");
    const transport: Transport = (url, init) =>
      cpo.handle(new Request(url, init));
    const pages = [];
    for await (const page of ocpiPages(
      {
        url: cpo.urls.locations,
        token: "emsp-token",
        dateFrom: new Date("2026-10-01T00:00:00.123Z"),
        dateTo: "2026-10-21T00:00:00Z",
      },
      { transport },
    ))
      pages.push(page);
    expect(pages.map((p) => p.items.length)).toEqual([2, 2, 1]);
    expect(pages[0]).toMatchObject({ totalCount: 5, limit: 2 });
    const correlation = new Set(
      cpo.state.requests.map((r) => r.headers["x-correlation-id"]),
    );
    expect(correlation.size).toBe(1);

    const all = [];
    for await (const item of ocpiPaginate(
      { url: cpo.urls.locations, token: "emsp-token" },
      { transport },
    ))
      all.push(item);
    expect(all.map((l) => (l as { id: string }).id)).toEqual([
      "LOC1",
      "LOC2",
      "LOC3",
      "LOC4",
      "LOC5",
    ]);
  });

  it("sends offset, limit and the date filters on the first request", async () => {
    const { transport, requests } = scripted(
      envelope({ data: [], status_code: 1000 }),
    );
    for await (const _ of ocpiPaginate(
      {
        url: URL_,
        token: TOKEN,
        offset: 0,
        limit: 50,
        dateFrom: "2026-10-01T00:00:00Z",
        dateTo: new Date("2026-10-02T00:00:00Z"),
      },
      opts(transport),
    ));
    const q = new URL(requests[0].url).searchParams;
    expect(Object.fromEntries(q)).toEqual({
      offset: "0",
      limit: "50",
      date_from: "2026-10-01T00:00:00Z",
      date_to: "2026-10-02T00:00:00Z",
    });
  });

  it("never follows a next link to another origin", async () => {
    const { transport, requests } = scripted(
      envelope(
        { data: [1], status_code: 1000 },
        { headers: { Link: '<https://evil.example.test/steal>; rel="next"' } },
      ),
    );
    const items: unknown[] = [];
    await expect(async () => {
      for await (const item of ocpiPaginate(
        { url: URL_, token: TOKEN },
        opts(transport),
      ))
        items.push(item);
    }).rejects.toThrow(/another origin/);
    expect(items).toEqual([1]);
    expect(requests).toHaveLength(1);
  });

  it("stops on a loop, a page limit or a page that is not a list", async () => {
    const loop = () =>
      envelope(
        { data: [], status_code: 1000 },
        { headers: { Link: `<${URL_}?offset=1>; rel="next"` } },
      );
    const drain = async (t: Transport, maxPages?: number) => {
      for await (const _ of ocpiPages(
        { url: URL_, token: TOKEN, maxPages },
        opts(t),
      ));
    };
    await expect(
      drain(scripted(loop(), loop(), loop()).transport),
    ).rejects.toThrow(/linked back/);
    await expect(drain(scripted(loop()).transport, 1)).rejects.toThrow(
      /more than 1 pages/,
    );
    await expect(
      drain(scripted(envelope({ data: {}, status_code: 1000 })).transport),
    ).rejects.toThrow(/not a list/);
  });
});
