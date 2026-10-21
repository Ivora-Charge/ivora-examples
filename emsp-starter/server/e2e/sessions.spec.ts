import { expect, test } from "@playwright/test";

test("OCPI sessions and CDRs endpoints refuse unknown tokens", async ({
  request,
}) => {
  const headers = { Authorization: `Token ${btoa("unknown")}` };
  for (const res of [
    await request.put("/ocpi/2.2.1/sessions/ZZ/MCK/SESSION-1", {
      headers,
      data: {},
    }),
    await request.patch("/ocpi/2.2.1/sessions/ZZ/MCK/SESSION-1", {
      headers,
      data: { last_updated: "2026-10-21T10:00:00Z" },
    }),
    await request.post("/ocpi/2.2.1/cdrs", { headers, data: {} }),
    await request.get("/ocpi/2.2.1/cdrs/00000000-0000-4000-8000-000000000000", {
      headers,
    }),
  ]) {
    expect(res.status()).toBe(401);
    expect(await res.json()).toMatchObject({ status_code: 2000 });
  }
});
