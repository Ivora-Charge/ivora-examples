export type Site = { id: string; name: string; address: string };

export type Connector = { id: number; label: string };

export type ConnectionState = "waiting" | "connected" | "booted" | "offline";

export type BootInfo = {
  vendor: string;
  model: string;
  firmware: string;
  connectors: Connector[];
};

export type TestResult = {
  passed: boolean;
  energyKwh: number;
  startedAt: string;
  finishedAt: string;
  config: { HeartbeatInterval: number; MeterValueSampleInterval: number };
};

export type Charger = {
  id: string;
  siteId: string;
  name: string;
  createdAt: string;
  demo: boolean;
  /** Masked after first display; the plain password is never stored. */
  passwordMasked: string;
  state: ConnectionState;
  boot?: BootInfo;
  test?: TestResult;
  tariffCentsPerKwh?: number;
};
