import "server-only";
import { IvoraError } from "./errors";
import type {
  IvoraClient,
  Location,
  LocationInput,
  Station,
  Transaction,
} from "./types";

// Sample data for demo mode. Every name says "Sample" or starts with DEMO- so it cannot
// be mistaken for a real site, charger or person.

const SAMPLE_LOCATIONS: Location[] = [
  {
    id: 9001,
    name: "Sample Site: Harbour Car Park",
    address: "1 Example Quay",
    city: "Sampleton",
    postal_code: "00001",
    country: "US",
    external_reference: "cpo-demo-site-1",
  },
  {
    id: 9002,
    name: "Sample Site: Market Street",
    address: "20 Example Street",
    city: "Sampleton",
    postal_code: "00002",
    country: "US",
    external_reference: "cpo-demo-site-2",
  },
];

const connectors = (stationId: number, n: number, maxPowerW: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: stationId * 10 + i + 1,
    number: i + 1,
    status: "Available",
    max_power_w: maxPowerW,
  }));

const SAMPLE_STATIONS: Station[] = [
  {
    id: 9101,
    name: "DEMO-HARBOUR-01",
    online: true,
    location_id: 9001,
    protocol: "ocpp1.6",
    vendor: "Sample Vendor",
    model: "Sample AC 22",
    last_seen: "2026-01-01T00:00:00Z",
    connectors: connectors(9101, 2, 22_000),
  },
  {
    id: 9102,
    name: "DEMO-HARBOUR-02",
    online: true,
    location_id: 9001,
    protocol: "ocpp1.6",
    vendor: "Sample Vendor",
    model: "Sample AC 22",
    last_seen: "2026-01-01T00:00:00Z",
    connectors: connectors(9102, 2, 22_000).map((c, i) =>
      i === 0 ? { ...c, status: "Charging" } : c,
    ),
  },
  {
    id: 9103,
    name: "DEMO-MARKET-01",
    online: false,
    location_id: 9002,
    protocol: "ocpp2.0.1",
    vendor: "Sample Vendor",
    model: "Sample DC 60",
    last_seen: "2026-01-01T00:00:00Z",
    connectors: connectors(9103, 1, 60_000).map((c) => ({
      ...c,
      status: "Unavailable",
    })),
  },
];

const SAMPLE_TRANSACTIONS: Transaction[] = [
  {
    id: 9201,
    station_id: 9102,
    connector_id: 91021,
    active: true,
    started_at: "2026-01-01T08:00:00Z",
    ended_at: null,
    energy_wh: 7_450,
  },
  {
    id: 9202,
    station_id: 9101,
    connector_id: 91011,
    active: false,
    started_at: "2025-12-31T17:10:00Z",
    ended_at: "2025-12-31T19:40:00Z",
    energy_wh: 31_200,
  },
];

const copy = <T>(v: T): T => structuredClone(v);

/**
 * The demo implementation of the Ivora client. It answers from the sample data above
 * (writes go to process memory) and never sends a request anywhere: no charger
 * commands, no payments, no email, no network.
 */
export function createDemoClient(): IvoraClient {
  const locations = copy(SAMPLE_LOCATIONS);
  const stations = copy(SAMPLE_STATIONS);
  const transactions = copy(SAMPLE_TRANSACTIONS);
  // Same key, same answer, like the API's idempotent replays.
  const replays = new Map<string, Location>();

  return {
    mode: "demo",
    async listLocations(o = {}) {
      return copy(
        locations
          .filter(
            (l) =>
              !o.external_reference ||
              l.external_reference === o.external_reference,
          )
          .slice(0, o.limit ?? 100),
      );
    },
    async listAllLocations() {
      return { data: copy(locations), truncated: false };
    },
    async listAllStations() {
      return { data: copy(stations), truncated: false };
    },
    async createLocation(input: LocationInput, key: string) {
      const seen =
        replays.get(key) ??
        locations.find(
          (l) => l.external_reference === input.external_reference,
        );
      if (seen) return copy(seen);
      const created: Location = {
        id: 9001 + locations.length,
        ...input,
        name: input.name.startsWith("Sample")
          ? input.name
          : `Sample Site: ${input.name}`,
      };
      locations.push(created);
      replays.set(key, created);
      return copy(created);
    },
    async listStations(o = {}) {
      return copy(
        stations
          .filter(
            (s) =>
              !o.external_reference ||
              s.external_reference === o.external_reference,
          )
          .slice(0, o.limit ?? 100),
      );
    },
    async getStation(stationId: number) {
      const s = stations.find((x) => x.id === stationId);
      if (!s)
        throw new IvoraError(404, "station_not_found", "Unknown demo station");
      return copy(s);
    },
    async listTransactions(o = {}) {
      return copy(
        transactions
          .filter(
            (t) => o.station_id === undefined || t.station_id === o.station_id,
          )
          .slice(0, o.limit ?? 50),
      );
    },
  };
}
