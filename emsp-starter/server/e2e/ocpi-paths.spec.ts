import { expect, test } from "@playwright/test";

// The real router behind proxy.ts (next start): a path under /ocpi that cannot name an
// endpoint is a 404 in the OCPI envelope, and every other path reaches its handler.

test("a bad percent-escape under /ocpi is a 404, not a 500 from the router", async ({
  request,
}) => {
  for (const path of [
    "/ocpi/2.2.1/tokens/%E0%A4%A",
    "/ocpi/2.2.1/locations/NL/ABC/%",
    "/ocpi/2.2.1/sessions/NL/ABC/%00",
  ]) {
    const res = await request.get(path, {
      headers: { "X-Request-ID": "e2e-req", "X-Correlation-ID": "e2e-corr" },
    });
    expect(res.status(), path).toBe(404);
    expect(await res.json()).toMatchObject({ status_code: 2001 });
    expect(res.headers()["cache-control"]).toBe("no-store");
    expect(res.headers()["x-request-id"]).toBe("e2e-req");
    expect(res.headers()["x-correlation-id"]).toBe("e2e-corr");
  }
});

test("an OCPI ID with a backslash reaches the handler", async ({ request }) => {
  const res = await request.get("/ocpi/2.2.1/locations/NL/ABC/A%5CB", {
    headers: { "X-Request-ID": "e2e-req" },
  });
  // No credentials token: the handler's own refusal, not the proxy's 404.
  expect(res.status()).toBe(401);
  expect(res.headers()["x-request-id"]).toBe("e2e-req");
  expect((await res.json()).status_code).toBeGreaterThanOrEqual(2000);
});
