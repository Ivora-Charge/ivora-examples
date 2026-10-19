export interface Driver {
  id: string;
  name: string;
  email?: string;
  idTag?: string;
  cardBlocked: boolean;
}

export interface Vehicle {
  id: string;
  name: string;
  plate: string;
  kind: "van" | "bus" | "car";
  batteryKwh: number;
  maxKw: number;
  driverId?: string;
  /** Departure time (ISO) and what is needed by then. */
  departure?: string;
  need?:
    { kind: "kwh"; kwh: number } | { kind: "battery"; targetPercent: number };
  socPercent?: number;
}

export interface Session {
  id: string;
  vehicleId: string;
  stationId: string;
  connectorId: number;
  startedAt: string;
  /** Meter register at start, Wh. */
  meterStartWh: number;
  /** Latest meter register, Wh. */
  meterWh: number;
  allocatedKw: number;
  profile?: {
    status: "pending" | "accepted" | "rejected";
    at: string;
    detail?: string;
    composite?: string;
  };
}

export interface Transaction {
  id: string;
  vehicleId: string;
  driverId: string;
  startedAt: string;
  meterStartWh: number;
  meterStopWh: number;
}

export interface DepotEvent {
  at: string;
  type: string;
  detail: string;
}

export interface Settings {
  siteCapKw: number;
  centsPerKwh: number;
  currency: string;
}
