import { expect, test } from "@playwright/test";
import { E2E_ADMIN_SECRET } from "../playwright.config";

// Demo mode: the location API serves the built-in mock CPO's sample data, offline.
test("demo: the app's location search, detail and price preview", async ({
  request,
}) => {
  const res = await request.get(
    "/api/v1/locations?q=station&status=AVAILABLE&connector=IEC_62196_T2_COMBO",
  );
  expect(res.ok()).toBe(true);
  expect(res.headers()["access-control-allow-origin"]).toBe("*");
  const search = await res.json();
  expect(search).toMatchObject({ mode: "demo" });
  expect(search.items[0]).toMatchObject({
    name: "Station Square",
    max_power_kw: 150,
  });

  const id = search.items[0].id;
  const detail = await (await request.get(`/api/v1/locations/${id}`)).json();
  const [evse] = detail.location.evses;
  expect(evse.connectors[0].price.summary).toContain("per kWh");

  const preview = await request.get(
    `/api/v1/locations/${id}/price-preview?evse_uid=${evse.uid}&connector_id=1&kwh=30&minutes=60&start=2026-10-21T10:00:00Z`,
  );
  expect(await preview.json()).toMatchObject({
    display_only: true,
    preview: { text: "€23.23" },
  });

  const bad = await request.get("/api/v1/locations?lat=91&lng=0");
  expect(bad.status()).toBe(400);
});

test("demo: pulling locations from a CPO is refused, nothing sent", async ({
  page,
}) => {
  await page.goto("/admin/peers");
  const sync = page.getByRole("region", { name: "Pull locations and tariffs" });
  await sync.getByLabel("Peer ID").fill("00000000-0000-4000-8000-000000000000");
  await sync.getByLabel("Admin secret").fill(E2E_ADMIN_SECRET);
  await sync.getByRole("button", { name: "Pull changes" }).click();
  await expect(sync.getByRole("alert")).toHaveText(
    "Demo mode: refused to pull locations and tariffs from a CPO. Nothing was sent.",
  );
});
