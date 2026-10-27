import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { NextRequest } from "next/server";
import { DEMO_BOOT_AFTER_MS } from "@/lib/demo";
import { PASSWORD_PATTERN } from "@/lib/credentials";
import { resetStoreForTests } from "@/lib/server/store";
import { POST as addChargerRoute } from "@/app/api/chargers/route";
import { GET as getCharger } from "@/app/api/chargers/[id]/route";
import { POST as testRoute } from "@/app/api/chargers/[id]/test/route";
import { POST as inServiceRoute } from "@/app/api/chargers/[id]/in-service/route";
import { POST as configRoute } from "@/app/api/chargers/[id]/config/route";
import { GET as stickerRoute } from "@/app/api/chargers/[id]/sticker/route";
import { GET as reportRoute } from "@/app/api/chargers/[id]/report/route";
import { POST as sitesRoute } from "@/app/api/sites/route";
import { POST as tariffRoute } from "@/app/api/chargers/[id]/tariff/route";
import { resolveStickerCode } from "@/lib/server/service";

const ORIGIN = "http://localhost:3000";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (path: string, body: unknown) =>
  new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      origin: ORIGIN,
      host: "localhost:3000",
      "content-type": "application/json",
    },
  });
const get = (path: string) =>
  new NextRequest(`${ORIGIN}${path}`, { headers: { host: "localhost:3000" } });

describe("demo mode end to end", () => {
  const saved = { ...process.env };
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetStoreForTests();
    for (const k of [
      "IVORA_API_KEY",
      "IVORA_TENANT_ID",
      "OPERATOR_PASSWORD",
      "QR_BASE_URL",
    ])
      delete process.env[k];
    // Demo must never reach the network: any fetch fails the test.
    fetchSpy = vi.fn(() => {
      throw new Error("demo mode must not call fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 19, 12));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  it("prices in the picked location's currency: a CAD demo site next to the USD ones", async () => {
    const site = await (
      await sitesRoute(
        post("/api/sites", { locationId: "demo-loc-3" }),
        undefined as never,
      )
    ).json();
    expect(site.currency).toBe("CAD");
    const created = await (
      await addChargerRoute(
        post("/api/chargers", { siteId: site.id, name: "ik-cad-1" }),
        undefined as never,
      )
    ).json();
    const id: string = created.charger.id;
    const bad = await tariffRoute(
      post(`/api/chargers/${id}/tariff`, { minorPerKwh: 40, currency: "ZZZ1" }),
      ctx(id),
    );
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const charger = await (
      await tariffRoute(
        post(`/api/chargers/${id}/tariff`, {
          minorPerKwh: 40,
          currency: "cad",
        }),
        ctx(id),
      )
    ).json();
    expect(charger.tariffMinorPerKwh).toBe(40);
    expect(charger.tariffCurrency).toBe("CAD");
  });

  it("connects, tests, reads config and hands over without any network call", async () => {
    const site = await (
      await sitesRoute(
        post("/api/sites", { name: "Sample Depot", address: "1 Example Way" }),
        undefined as never,
      )
    ).json();
    expect(site.locationId).toMatch(/^demo-loc-/);

    // Add charger: the password appears in this response and nowhere else.
    const created = await (
      await addChargerRoute(
        post("/api/chargers", {
          siteId: site.id,
          name: "ik-demo-1",
          connectors: 2,
        }),
        undefined as never,
      )
    ).json();
    const password: string = created.password;
    expect(password).toMatch(PASSWORD_PATTERN);
    expect(created.qr.url).toContain("<svg");
    expect(created.charger.connectionUrl).toBe(
      "wss://ocpp.demo.invalid/ocpp16/ik-demo-1",
    );
    const id: string = created.charger.id;

    // Waiting, then booted a few seconds later.
    let charger = await (
      await getCharger(get(`/api/chargers/${id}`), ctx(id))
    ).json();
    expect(charger.state).toBe("waiting");
    vi.setSystemTime(Date.now() + DEMO_BOOT_AFTER_MS + 100);
    const res = await getCharger(get(`/api/chargers/${id}`), ctx(id));
    const raw = await res.text();
    charger = JSON.parse(raw);
    expect(charger.state).toBe("booted");
    expect(charger.boot.vendor).toContain("simulated");
    expect(charger.connectors.map((k: { number: number }) => k.number)).toEqual(
      [1, 2],
    );
    // Credential masking: later reads never carry the password.
    expect(raw).not.toContain(password);
    expect(charger.passwordMasked).toBe("••••••••••••");

    // Test session: start, charge for 30 s, stop.
    charger = await (
      await testRoute(
        post(`/api/chargers/${id}/test`, { action: "start", connector: 1 }),
        ctx(id),
      )
    ).json();
    expect(charger.test.phase).toBe("charging");
    vi.setSystemTime(Date.now() + 30_000);
    charger = await (
      await testRoute(
        post(`/api/chargers/${id}/test`, { action: "stop" }),
        ctx(id),
      )
    ).json();
    expect(charger.test).toMatchObject({
      phase: "done",
      passed: true,
      energyWh: 92,
    });

    // Configuration: read, change, read back.
    charger = (
      await (
        await configRoute(
          post(`/api/chargers/${id}/config`, { action: "read" }),
          ctx(id),
        )
      ).json()
    ).charger;
    expect(charger.config.values).toEqual({
      HeartbeatInterval: "300",
      MeterValueSampleInterval: "60",
    });
    const changed = await (
      await configRoute(
        post(`/api/chargers/${id}/config`, {
          key: "HeartbeatInterval",
          value: 120,
        }),
        ctx(id),
      )
    ).json();
    expect(changed.chargerStatus).toBe("Accepted");
    expect(changed.charger.config.values.HeartbeatInterval).toBe("120");

    // Hand-over: a DEMO sticker per connector with a stable code, and the report.
    const code = charger.connectors[1].code;
    const sticker = await stickerRoute(
      get(`/api/chargers/${id}/sticker?connector=2`),
      ctx(id),
    );
    expect(sticker.headers.get("content-type")).toBe("application/pdf");
    const pdf = await PDFDocument.load(
      new Uint8Array(await sticker.arrayBuffer()),
    );
    expect(pdf.getTitle()).toBe(`Charging sticker ${code}`);
    expect(resolveStickerCode(code)).toMatchObject({ connectorNumber: 2 });
    expect(code).not.toContain(charger.stationId);

    const report = await reportRoute(
      get(`/api/chargers/${id}/report`),
      ctx(id),
    );
    expect(report.status).toBe(200);
    expect(
      Buffer.from(await report.arrayBuffer())
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-");

    // Mark in service: recorded with its time, and tests are refused after it.
    charger = await (
      await inServiceRoute(post(`/api/chargers/${id}/in-service`, {}), ctx(id))
    ).json();
    expect(charger.inServiceAt).toBe(new Date().toISOString());
    const refused = await testRoute(
      post(`/api/chargers/${id}/test`, { action: "start", connector: 1 }),
      ctx(id),
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "in_service" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses writes from another origin", async () => {
    const res = await sitesRoute(
      new NextRequest(`${ORIGIN}/api/sites`, {
        method: "POST",
        body: "{}",
        headers: { origin: "https://evil.example", host: "localhost:3000" },
      }),
      undefined as never,
    );
    expect(res.status).toBe(403);
  });

  it("refuses printable stickers when QR_BASE_URL is an Ivora domain", async () => {
    process.env.QR_BASE_URL = "https://stickers.ivoracharge.com";
    const site = await (
      await sitesRoute(
        post("/api/sites", { name: "S", address: "A" }),
        undefined as never,
      )
    ).json();
    const created = await (
      await addChargerRoute(
        post("/api/chargers", { siteId: site.id, name: "ik-demo-2" }),
        undefined as never,
      )
    ).json();
    vi.setSystemTime(Date.now() + DEMO_BOOT_AFTER_MS + 100);
    await getCharger(get("/x"), ctx(created.charger.id));
    const res = await stickerRoute(
      get(`/x?connector=1`),
      ctx(created.charger.id),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("qr_base_url_invalid");
  });
});
