import "server-only";
import { createHash } from "node:crypto";
import QRCode from "qrcode";
import { DEMO_CHARGERS, DEMO_SITE_NAME, DEMO_TARIFF } from "../demo";
import { applicationFeeCents } from "../money";
import type { Settings } from "../settings";
import {
  elementsFromPrices,
  formFromTariff,
  priceBreakdown,
  priceLines,
  type PriceForm,
  type Tariff,
} from "../tariff";
import { startOfLocalDay } from "../time";
import { liveDeps, ivoraClient } from "./services";
import { STORE_PREFIX } from "../store";
import { APPLICATION_PREFIX } from "./sessions";

// Operator pages: prices per charger, today's sessions and revenue, recent
// faults. Live mode reads the Ivora API; demo mode returns labelled sample data.

export type SessionRow = {
  reference: string;
  createdAt: string;
  station: string;
  status: string;
  energyWh: number;
  billedCents: number | null;
  capturedCents: number;
  feeCents: number;
  /** Card through Stripe, or cash or card at the store's own POS. */
  paidVia: "card" | "store";
};

export type Overview = {
  demo: boolean;
  siteName: string;
  from: string;
  sessions: number;
  activeSessions: number;
  energyKwh: string;
  successRate: string | null;
  billedCents: number | null;
  /** Card payments captured through Stripe. */
  capturedCents: number;
  /** Recorded as paid in store (settlement reports; the money never touches Stripe). */
  inStoreCents: number;
  feeCents: number;
  feeBps: number;
  chargesFee: boolean;
  stations: { total: number; online: number; offline: number; faulted: number };
  rows: SessionRow[];
};

export async function overview(
  settings: Settings,
  now = Date.now(),
): Promise<Overview> {
  const from = startOfLocalDay(now, settings.siteTimeZone).toISOString();
  if (settings.demo) return demoOverview(settings, from);
  const ivora = ivoraClient(settings);
  const deps = liveDeps(settings);
  const [stats, { sessions }, stations] = await Promise.all([
    ivora.stats({
      from,
      to: new Date(now).toISOString(),
      timeZone: settings.siteTimeZone,
    }),
    ivora.listAllSessions(),
    ivora.listStations(),
  ]);
  const names = new Map(stations.map((s) => [s.id, s.name]));
  const rows = sessions
    .filter(
      (s) =>
        s.application_reference.startsWith(APPLICATION_PREFIX) &&
        s.created_at >= from,
    )
    .map((s): SessionRow => {
      const captured = s.settlement?.captured_minor ?? 0;
      const store = s.application_reference.startsWith(STORE_PREFIX);
      return {
        reference: s.id,
        createdAt: s.created_at,
        station: names.get(s.bill.station_id) ?? `Station ${s.bill.station_id}`,
        status: s.status,
        energyWh: s.bill.energy_wh ?? s.usage?.energy_wh ?? 0,
        billedCents: s.bill.total_minor,
        capturedCents: captured,
        // In-store payments never touch Stripe, so they carry no application fee.
        feeCents:
          deps.payments.chargesApplicationFee && !store
            ? applicationFeeCents(captured, settings.applicationFeeBps)
            : 0,
        paidVia: store ? "store" : "card",
      };
    });
  const sum = (via: SessionRow["paidVia"]) =>
    rows
      .filter((r) => r.paidVia === via)
      .reduce((total, r) => total + r.capturedCents, 0);
  const usd = stats.revenue?.currencies.find((c) => c.currency === "USD");
  return {
    demo: false,
    siteName: process.env.SITE_NAME || "Your forecourt",
    from,
    sessions: stats.totals.sessions,
    activeSessions: stats.totals.active_sessions,
    energyKwh: stats.totals.energy_kwh,
    successRate: stats.totals.success_rate,
    billedCents: usd ? usd.billed_minor : null,
    capturedCents: sum("card"),
    inStoreCents: sum("store"),
    feeCents: rows.reduce((total, r) => total + r.feeCents, 0),
    feeBps: settings.applicationFeeBps,
    chargesFee: deps.payments.chargesApplicationFee,
    stations: stats.stations,
    rows,
  };
}

function demoOverview(settings: Settings, from: string): Overview {
  const base = Date.parse(from);
  const sample = [
    { h: 7.2, station: "Demo charger 1", wh: 41_250, billed: 2_215 },
    { h: 9.6, station: "Demo charger 2", wh: 28_900, billed: 1_683 },
    { h: 12.1, station: "Demo charger 1", wh: 35_400, billed: 2_041 },
    { h: 13.4, station: "Demo charger 2", wh: 12_050, billed: 802 },
    { h: 14.2, station: "Demo charger 6", wh: 30_400, billed: 1_754, store: 1 },
  ];
  const rows = sample.map((s, i): SessionRow => ({
    reference: `demo-session-${i + 1}`,
    createdAt: new Date(base + s.h * 3_600_000).toISOString(),
    station: s.station,
    status: "completed",
    energyWh: s.wh,
    billedCents: s.billed,
    capturedCents: s.billed,
    feeCents:
      "store" in s
        ? 0
        : applicationFeeCents(s.billed, settings.applicationFeeBps),
    paidVia: "store" in s ? "store" : "card",
  }));
  const billed = rows.reduce((sum, r) => sum + (r.billedCents ?? 0), 0);
  const via = (v: SessionRow["paidVia"]) =>
    rows
      .filter((r) => r.paidVia === v)
      .reduce((sum, r) => sum + r.capturedCents, 0);
  return {
    demo: true,
    siteName: DEMO_SITE_NAME,
    from,
    sessions: rows.length + 1,
    activeSessions: 1,
    energyKwh: (rows.reduce((sum, r) => sum + r.energyWh, 0) / 1000).toFixed(3),
    successRate: "1.0000",
    billedCents: billed,
    capturedCents: via("card"),
    inStoreCents: via("store"),
    feeCents: rows.reduce((sum, r) => sum + r.feeCents, 0),
    feeBps: settings.applicationFeeBps,
    chargesFee: true,
    stations: {
      total: DEMO_CHARGERS.length,
      online: DEMO_CHARGERS.filter((c) => c.online).length,
      offline: DEMO_CHARGERS.filter((c) => !c.online).length,
      faulted: 1,
    },
    rows,
  };
}

export type ConnectorPrice = {
  stationName: string;
  code: string | null;
  connector: number;
  status: string;
  tariffId: number | null;
  driverUrl: string | null;
  qrSvg: string | null;
};

export type TariffCard = {
  tariff: Tariff;
  lines: { label: string; value: string }[];
  form: PriceForm | null;
  usedBy: string[];
};

export type PricesPage = {
  demo: boolean;
  connectors: ConnectorPrice[];
  tariffs: TariffCard[];
  qrProblem: string | null;
};

/** QR codes point at your own HTTPS domain, never an Ivora or preview URL. */
export function qrProblem(settings: Settings): string | null {
  if (settings.demo) return null;
  const url = new URL(settings.publicBaseUrl);
  if (url.protocol !== "https:")
    return "Set PUBLIC_BASE_URL to your HTTPS domain to print QR codes.";
  if (url.hostname.endsWith(".vercel.app"))
    return "PUBLIC_BASE_URL is a preview domain. Use your own domain for printed QR codes.";
  return null;
}

async function qr(url: string) {
  return QRCode.toString(url, { type: "svg", margin: 1, width: 132 });
}

export async function pricesPage(settings: Settings): Promise<PricesPage> {
  const problem = qrProblem(settings);
  if (settings.demo) {
    const connectors: ConnectorPrice[] = [];
    for (const c of DEMO_CHARGERS)
      for (const k of c.connectors) {
        const driverUrl = `${settings.publicBaseUrl}/c/${c.code}/${k.number}`;
        connectors.push({
          stationName: c.name,
          code: c.code,
          connector: k.number,
          status: k.status,
          tariffId: DEMO_TARIFF.id,
          driverUrl,
          qrSvg: await qr(driverUrl),
        });
      }
    return {
      demo: true,
      connectors,
      tariffs: [card(DEMO_TARIFF, connectors)],
      qrProblem: null,
    };
  }
  const ivora = ivoraClient(settings);
  const stations = await ivora.listStations();
  const connectors: ConnectorPrice[] = [];
  for (const s of stations)
    for (const c of s.connectors) {
      const code = s.external_reference ?? null;
      const driverUrl =
        code && c.number
          ? `${settings.publicBaseUrl}/c/${encodeURIComponent(code)}/${c.number}`
          : null;
      connectors.push({
        stationName: s.name,
        code,
        connector: c.number ?? 0,
        status: s.online ? (c.status ?? "Unknown") : "Offline",
        tariffId: c.tariff_id,
        driverUrl,
        qrSvg: driverUrl && !problem ? await qr(driverUrl) : null,
      });
    }
  const ids = [
    ...new Set(
      connectors
        .map((c) => c.tariffId)
        .filter((id): id is number => id !== null),
    ),
  ];
  const tariffs = await Promise.all(ids.map((id) => ivora.getTariff(id)));
  return {
    demo: false,
    connectors,
    tariffs: tariffs.map((t) => card(t, connectors)),
    qrProblem: problem,
  };
}

function card(tariff: Tariff, connectors: ConnectorPrice[]): TariffCard {
  return {
    tariff,
    lines: priceLines(priceBreakdown(tariff)),
    form: formFromTariff(tariff),
    usedBy: connectors
      .filter((c) => c.tariffId === tariff.id)
      .map((c) => `${c.stationName} #${c.connector}`),
  };
}

/** Replace a tariff's prices. Bills already open keep the price they started with. */
export async function savePrices(
  settings: Settings,
  tariffId: number,
  form: PriceForm,
) {
  const elements = elementsFromPrices(form);
  if (settings.demo) return { saved: false as const };
  const body = { elements, authorization_minor: form.holdCents };
  const hash = createHash("sha256")
    .update(JSON.stringify(body))
    .digest("hex")
    .slice(0, 24);
  await ivoraClient(settings).updateTariff(
    tariffId,
    body,
    `forecourt:tariff:${tariffId}:${hash}`,
  );
  return { saved: true as const };
}

export type FaultRow = {
  id: string;
  station: string;
  connectorId: number | null;
  open: boolean;
  errorCode: string | null;
  info: string | null;
  openedAt: string;
  clearedAt: string | null;
};

export async function faultsPage(
  settings: Settings,
): Promise<{ demo: boolean; rows: FaultRow[] }> {
  if (settings.demo) {
    const now = Date.now();
    return {
      demo: true,
      rows: [
        {
          id: "demo-fault-1",
          station: "Demo charger 2",
          connectorId: 2,
          open: true,
          errorCode: "GroundFailure",
          info: "Sample fault (demo data)",
          openedAt: new Date(now - 47 * 60_000).toISOString(),
          clearedAt: null,
        },
        {
          id: "demo-fault-2",
          station: "Demo charger 1",
          connectorId: 1,
          open: false,
          errorCode: "HighTemperature",
          info: "Sample fault (demo data)",
          openedAt: new Date(now - 5 * 3_600_000).toISOString(),
          clearedAt: new Date(now - 4.6 * 3_600_000).toISOString(),
        },
      ],
    };
  }
  const ivora = ivoraClient(settings);
  const stations = await ivora.listStations();
  const lists = await Promise.all(
    stations.map((s) =>
      ivora.faults(s.id, 10).then((f) => f.map((x) => ({ x, name: s.name }))),
    ),
  );
  const rows = lists
    .flat()
    .sort((a, b) => b.x.opened_at.localeCompare(a.x.opened_at))
    .slice(0, 30)
    .map(({ x, name }) => ({
      id: x.id,
      station: name,
      connectorId: x.connector_id,
      open: x.open,
      errorCode: x.error_code ?? x.ocpp_status,
      info: x.info ?? x.vendor_error_code,
      openedAt: x.opened_at,
      clearedAt: x.cleared_at,
    }));
  return { demo: false, rows };
}
