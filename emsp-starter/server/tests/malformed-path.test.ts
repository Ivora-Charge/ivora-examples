import { describe, expect, it } from "vitest";
import { isMalformedOcpiPath } from "@/lib/ocpi/malformed-path";
import { proxy, config } from "@/proxy";
import { NextRequest } from "next/server";

describe("malformed OCPI paths", () => {
  it.each([
    "/ocpi/2.2.1/tokens/%E0%A4%A",
    "/ocpi/2.2.1/tokens/%",
    "/ocpi/2.2.1/%2e%2e/tokens",
    "/ocpi/2.2.1/tokens/%00",
    "/ocpi/2.2.1/locations/NL/ABC/%0d%0a",
  ])("%s is malformed", (p) => expect(isMalformedOcpiPath(p)).toBe(true));

  it.each([
    "/ocpi/versions",
    "/ocpi/2.2.1/tokens",
    "/ocpi/2.2.1/tokens/NL/ABC/tok%20en%C3%A9",
    "/ocpi/2.2.1/locations/NL/ABC/LOC1/EVSE-1",
    // A backslash is printable ASCII, so it may be part of an OCPI ID.
    "/ocpi/2.2.1/locations/NL/ABC/A%5CB",
    "/ocpi/2.2.1/tokens%5C",
    "/ocpi/2.2.1/tokens/%5C",
  ])("%s is fine", (p) => expect(isMalformedOcpiPath(p)).toBe(false));

  it("the proxy answers 404 for a malformed path and passes others on", async () => {
    const bad = proxy(
      new NextRequest("https://x.test/ocpi/2.2.1/tokens/%E0%A4%A"),
    );
    expect(bad.status).toBe(404);
    const body = await bad.json();
    expect(body).toMatchObject({ status_code: 2001 });
    // The same timestamp format as every other OCPI answer (no milliseconds).
    expect(body.timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(bad.headers.get("cache-control")).toBe("no-store");
    expect(bad.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(bad.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
    for (const path of [
      "/ocpi/2.2.1/tokens",
      "/ocpi/2.2.1/locations/NL/ABC/A%5CB",
    ]) {
      const ok = proxy(new NextRequest(`https://x.test${path}`));
      expect(ok.headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("the proxy 404 echoes the caller's request and correlation IDs", () => {
    const res = proxy(
      new NextRequest("https://x.test/ocpi/2.2.1/tokens/%", {
        headers: { "X-Request-ID": "req-1", "X-Correlation-ID": "corr-1" },
      }),
    );
    expect(res.headers.get("x-request-id")).toBe("req-1");
    expect(res.headers.get("x-correlation-id")).toBe("corr-1");
  });

  it("only runs under /ocpi", () => {
    expect(config.matcher).toBe("/ocpi/:path*");
  });
});
