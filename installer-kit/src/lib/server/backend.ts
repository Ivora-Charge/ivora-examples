import "server-only";
import type {
  BootInfo,
  ConfigKey,
  ConnectionState,
  LocationOption,
  Site,
} from "../types";

export type StationSnapshot = {
  state: ConnectionState;
  boot: BootInfo | null;
  connectors: { resourceId: string; number: number }[];
};

export type TransactionSnapshot = {
  transactionId: string;
  active: boolean;
  startedAt: string | null;
  endedAt: string | null;
  energyWh: number;
};

/**
 * Everything the installer kit asks of a charging backend. The live
 * implementation calls the Ivora API; the demo one simulates a charger and
 * never touches the network. `key` arguments are idempotency keys derived
 * from our own record and action.
 */
export interface Backend {
  readonly demo: boolean;
  listLocations(): Promise<LocationOption[]>;
  createLocation(site: Site, key: string): Promise<string>;
  createStation(input: {
    key: string;
    reference: string;
    name: string;
    locationId: string;
    connectors: number;
  }): Promise<{ stationId: string; connectionUrl: string; username: string }>;
  setPassword(stationId: string, password: string, key: string): Promise<void>;
  getStation(stationId: string): Promise<StationSnapshot>;
  startCharging(
    stationId: string,
    connectorResourceId: string,
    key: string,
  ): Promise<void>;
  /** The newest transaction on the connector that started after `since`. */
  findTransaction(
    stationId: string,
    connectorResourceId: string,
    since: string,
  ): Promise<TransactionSnapshot | null>;
  getTransaction(transactionId: string): Promise<TransactionSnapshot>;
  stopCharging(
    stationId: string,
    transactionId: string,
    key: string,
  ): Promise<void>;
  /** Ask the charger for its configuration, then read the recorded values. */
  readConfiguration(
    stationId: string,
    keys: ConfigKey[],
    key: string,
  ): Promise<Record<ConfigKey, string | null>>;
  /** Change one standard OCPP 1.6 key; returns the charger's answer. */
  changeConfiguration(
    stationId: string,
    configKey: ConfigKey,
    value: string,
    key: string,
  ): Promise<string>;
}
