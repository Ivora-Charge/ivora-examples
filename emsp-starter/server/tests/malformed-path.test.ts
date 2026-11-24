import { describe, expect, it } from "vitest";
import { isMalformedOcpiPath } from "@/lib/ocpi/malformed-path";
import { proxy, config } from "@/proxy";
import { NextRequest } from "next/server";

describe("malformed OCPI paths", () => {
  it.each([
    "/ocpi/2.2.1/tokens%5C",
    "/ocpi/2.2.1/tokens%5c/x",
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
  ])("%s is fine", (p) => expect(isMalformedOcpiPath(p)).toBe(false));

  it("the proxy answers 404 for a malformed path and passes others on", async () => {
    const bad = proxy(new NextRequest("https://x.test/ocpi/2.2.1/tokens%5C"));
    expect(bad.status).toBe(404);
    expect(await bad.json()).toMatchObject({ status_code: 2001 });
    const ok = proxy(new NextRequest("https://x.test/ocpi/2.2.1/tokens"));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-middleware-next")).toBe("1");
  });

  it("only runs under /ocpi", () => {
    expect(config.matcher).toBe("/ocpi/:path*");
  });
});
