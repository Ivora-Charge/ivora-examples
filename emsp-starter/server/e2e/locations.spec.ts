import { expect, test } from "@playwright/test";

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

test("demo: a CAD location shows CA$ and a CA$ price preview next to the EUR ones", async ({
  request,
}) => {
  const search = await (
    await request.get("/api/v1/locations?q=harbourfront")
  ).json();
  expect(search.items.map((i: { name: string }) => i.name)).toEqual([
    "Harbourfront Garage",
  ]);
  const id = search.items[0].id;
  const detail = await (await request.get(`/api/v1/locations/${id}`)).json();
  const [evse] = detail.location.evses;
  expect(evse.connectors[0].price.currency).toBe("CAD");
  expect(evse.connectors[0].price.summary).toContain("CA$");
  expect(evse.connectors[0].price.summary).not.toContain("€");
  const preview = await (
    await request.get(
      `/api/v1/locations/${id}/price-preview?evse_uid=${evse.uid}&connector_id=1&kwh=30&minutes=60&start=2026-10-21T10:00:00Z`,
    )
  ).json();
  expect(preview.preview.text).toMatch(/^CA\$\d+\.\d{2}$/);
});
