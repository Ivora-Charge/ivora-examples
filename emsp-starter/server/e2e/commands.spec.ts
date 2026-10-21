import { expect, test } from "@playwright/test";

test("OCPI commands endpoint refuses unknown tokens", async ({ request }) => {
  const headers = { Authorization: `Token ${btoa("unknown")}` };
  const res = await request.post(
    "/ocpi/2.2.1/commands/START_SESSION/00000000-0000-4000-8000-000000000000",
    { headers, data: { result: "ACCEPTED" } },
  );
  expect(res.status()).toBe(401);
  expect(await res.json()).toMatchObject({ status_code: 2000 });
  expect((await request.get("/ocpi/2.2.1", { headers })).status()).toBe(401);
});
