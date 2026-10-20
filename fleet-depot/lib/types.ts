export interface Driver {
  id: string;
  name: string;
  email?: string;
  /** The card value (OCPP idTag). Shown masked in the browser. */
  idTag?: string;
  /** Ivora token resource ID, once known. */
  tokenId?: number;
  cardBlocked: boolean;
  /** Last error from registering the card, with the API's code. */
  cardError?: string;
}

export interface Vehicle {
  id: string;
  name: string;
  plate: string;
  kind: "van" | "bus" | "car";
  batteryKwh: number;
  /** The vehicle's own maximum AC charge power, kW. */
  maxKw: number;
  driverId?: string;
  /** Departure time (ISO) and what is needed by then. */
  departure?: string;
  need?:
    { kind: "kwh"; kwh: number } | { kind: "battery"; targetPercent: number };
  /** State of charge at plug-in, as last known. */
  socPercent?: number;
}

export interface ProfileState {
  /**
   * sending: written before the request so a retry reuses the same key and body.
   * pending/accepted/rejected follow the charger's answer; error is a failed request.
   */
  status: "sending" | "pending" | "accepted" | "rejected" | "error";
  /** Increases only when the plan changes; part of the idempotency key. */
  seq: number;
  key: string;
  /** The exact body sent with `key`, reused on retry. */
  body?: unknown;
  kw: number;
  at: string;
  /** Ivora profile resource ID (chp_...). */
  profileId?: string;
  detail?: string;
  /** What the station reported it will apply (composite schedule). */
  composite?: string;
  retriable?: boolean;
}

export interface Session {
  id: string;
  /** Unknown when the card could not be matched to a vehicle. */
  vehicleId?: string;
  /** Masked card hint from the transaction (****1234). */
  idTokenHint?: string;
  /** Ivora station resource ID (demo: a simulated number). */
  stationId: number;
  stationName?: string;
  protocol?: string;
  /** Ivora connector resource ID. */
  connectorId: number;
  /** OCPP connector number on the station, for display. */
  connectorNumber?: number;
  /** Connector rating, kW, when the station reports it. */
  connectorKw?: number;
  /** Ivora transaction resource ID (live mode). */
  transactionId?: number;
  startedAt: string;
  /** Meter register at start, Wh. */
  meterStartWh: number;
  /** Latest meter register, Wh. */
  meterWh: number;
  /** State of charge the charger reported, if any. */
  reportedSocPercent?: number;
  allocatedKw: number;
  profile?: ProfileState;
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
