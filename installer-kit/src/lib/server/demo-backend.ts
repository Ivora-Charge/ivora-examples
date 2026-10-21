import "server-only";
import { randomUUID } from "node:crypto";
import type { Backend, TransactionSnapshot } from "./backend";
import { HttpError } from "./errors";
import {
  DEMO_BOOT,
  DEMO_LOCATIONS,
  DEMO_METER_START_WH,
  demoMeterWh,
  demoState,
} from "../demo";
import type { ConfigKey } from "../types";

type DemoStation = {
  createdAt: string;
  connectors: number;
  config: Record<ConfigKey, string>;
  tx?: { id: string; connector: string; startedAt: string; endedAt?: string };
};

const g = globalThis as unknown as {
  __installerKitDemo?: Map<string, DemoStation>;
};
const stations = () => (g.__installerKitDemo ??= new Map());

function station(id: string) {
  const s = stations().get(id);
  if (!s) throw new HttpError(404, "not_found", "Unknown demo station.");
  return s;
}

function snapshot(s: DemoStation, now = Date.now()): TransactionSnapshot {
  const tx = s.tx!;
  const end = tx.endedAt ? Date.parse(tx.endedAt) : now;
  return {
    transactionId: tx.id,
    connectorResourceId: tx.connector,
    idToken: "****TEST",
    active: !tx.endedAt,
    startedAt: tx.startedAt,
    endedAt: tx.endedAt ?? null,
    energyWh: demoMeterWh(end - Date.parse(tx.startedAt)) - DEMO_METER_START_WH,
  };
}

/**
 * The demo implementation of the backend. It simulates one charger per
 * station in memory and never sends a request anywhere: no charger commands,
 * no payments, no network.
 */
export const demoBackend: Backend = {
  demo: true,

  async listLocations() {
    return DEMO_LOCATIONS;
  },

  async createLocation() {
    return `demo-loc-${randomUUID().slice(0, 8)}`;
  },

  async createStation({ name, connectors }) {
    const stationId = `demo-${randomUUID().slice(0, 8)}`;
    stations().set(stationId, {
      createdAt: new Date().toISOString(),
      connectors,
      config: { HeartbeatInterval: "300", MeterValueSampleInterval: "60" },
    });
    return {
      stationId,
      connectionUrl: `wss://ocpp.demo.invalid/ocpp16/${encodeURIComponent(name)}`,
      username: name,
    };
  },

  async setPassword(stationId) {
    station(stationId);
  },

  async getStation(stationId) {
    const s = station(stationId);
    const state = demoState(s.createdAt);
    return {
      state,
      boot: state === "booted" ? DEMO_BOOT : null,
      connectors: Array.from({ length: s.connectors }, (_, i) => ({
        resourceId: `${stationId}-c${i + 1}`,
        number: i + 1,
        status: null,
      })),
    };
  },

  async startCharging(stationId, connector) {
    const s = station(stationId);
    if (demoState(s.createdAt) !== "booted")
      throw new HttpError(409, "station_offline", "The charger is offline.");
    s.tx = {
      id: `demo-tx-${randomUUID().slice(0, 8)}`,
      connector,
      startedAt: new Date().toISOString(),
    };
  },

  async findTransaction(stationId) {
    const s = station(stationId);
    return s.tx ? snapshot(s) : null;
  },

  async hasActiveTransaction(stationId, connector) {
    const tx = station(stationId).tx;
    return !!tx && !tx.endedAt && tx.connector === connector;
  },

  async getTransaction(transactionId) {
    for (const s of stations().values())
      if (s.tx?.id === transactionId) return snapshot(s);
    throw new HttpError(404, "not_found", "Unknown demo transaction.");
  },

  async stopCharging(stationId) {
    const s = station(stationId);
    if (s.tx && !s.tx.endedAt) s.tx.endedAt = new Date().toISOString();
  },

  async readConfiguration(stationId, keys) {
    const s = station(stationId);
    return Object.fromEntries(keys.map((k) => [k, s.config[k]])) as Record<
      ConfigKey,
      string
    >;
  },

  async changeConfiguration(stationId, configKey, value) {
    station(stationId).config[configKey] = value;
    return "Accepted";
  },
};
