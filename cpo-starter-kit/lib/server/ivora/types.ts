import "server-only";

// Shapes follow the published OpenAPI (https://api.ivoracharge.com/openapi.json).
// Only the fields this template reads are listed.

export interface Page<T> {
  data: T[];
}

export interface Location {
  id: number;
  name: string;
  address?: string | null;
  city?: string | null;
  postal_code?: string | null;
  country?: string | null;
  external_reference?: string | null;
}

export interface LocationInput {
  name: string;
  address?: string;
  city?: string;
  postal_code?: string;
  country?: string;
  /** Derived from our own record, so a retry finds the record instead of duplicating it. */
  external_reference: string;
}

export interface Connector {
  id: number;
  number: number | null;
  status?: string | null;
  max_power_w?: number | null;
}

export interface Station {
  id: number;
  name: string;
  online: boolean;
  location_id?: number | null;
  protocol?: string | null;
  vendor?: string | null;
  model?: string | null;
  last_seen?: string | null;
  external_reference?: string | null;
  connectors: Connector[];
}

export interface Transaction {
  id: number;
  station_id: number | null;
  connector_id: number | null;
  /** The API may report null while the state is unknown. */
  active: boolean | null;
  started_at: string | null;
  ended_at: string | null;
  energy_wh?: number | null;
}

export interface ListOptions {
  /** 1 to 100 (the API's maximum). */
  limit?: number;
  external_reference?: string;
}

/**
 * Everything the starter kit asks of Ivora. The live implementation calls the API; the
 * demo implementation answers from labelled sample data and never touches the network.
 * Every write takes an idempotency key derived from our own record and action
 * (see `idempotencyKey`).
 */
export interface IvoraClient {
  readonly mode: "live" | "demo";
  listLocations(o?: ListOptions): Promise<Location[]>;
  createLocation(input: LocationInput, key: string): Promise<Location>;
  listStations(o?: ListOptions): Promise<Station[]>;
  getStation(stationId: number): Promise<Station>;
  listTransactions(o?: {
    limit?: number;
    station_id?: number;
  }): Promise<Transaction[]>;
}
