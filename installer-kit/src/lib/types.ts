export type SiteInput = {
  name: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  /** ISO 3166-1 alpha-3, as the Ivora locations API expects. */
  country: string;
};

export type Site = SiteInput & {
  id: string;
  /** Ivora location resource ID (demo: a demo-* ID). */
  locationId: string;
};

/** An Ivora location the installer can pick instead of creating a new site. */
export type LocationOption = {
  locationId: string;
  name: string;
  address: string;
};

export type ConnectionState = "waiting" | "connected" | "booted" | "offline";

export type Connector = {
  /** Connector resource ID from the stations API (commands take it). */
  resourceId: string;
  /** OCPP 1.6 connector number on the station. */
  number: number;
  /** Stable sticker code, assigned once and never derived from an ID. */
  code?: string;
};

export type BootInfo = {
  vendor: string | null;
  model: string | null;
  firmware: string | null;
};

export type TestPhase =
  "starting" | "charging" | "stopping" | "done" | "failed";

export type TestRun = {
  /** Increments per test, so each test has its own idempotency keys. */
  attempt: number;
  phase: TestPhase;
  connectorNumber: number;
  requestedAt: string;
  transactionId?: string;
  startedAt?: string;
  finishedAt?: string;
  energyWh: number;
  passed?: boolean;
  /** Error code when the test failed (API code or a local one). */
  errorCode?: string;
};

export type ConfigKey = "HeartbeatInterval" | "MeterValueSampleInterval";

export type ConfigReadback = {
  readAt: string;
  values: Record<ConfigKey, string | null>;
};

export type Charger = {
  id: string;
  siteId: string;
  /** OCPP connection name registered with Ivora. */
  name: string;
  stationId: string;
  connectionUrl: string;
  /** Basic auth username the charger sends (its connection name). */
  username: string;
  createdAt: string;
  demo: boolean;
  /** Masked after first display; the plain password is never stored. */
  passwordMasked: string;
  /** False when the last password change could not be confirmed. */
  passwordSet: boolean;
  state: ConnectionState;
  /** When the station was last seen connecting or booting. */
  lastChangeAt: string;
  boot?: BootInfo;
  connectors: Connector[];
  test?: TestRun;
  config?: ConfigReadback;
  tariffCentsPerKwh?: number;
  /** Counters that make idempotency keys unique per record and action. */
  seq: { credentials: number; test: number; config: number };
};
