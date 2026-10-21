export interface Driver {
  id: string;
  name: string;
  email?: string;
  /** The card value (OCPP idTag). Shown masked in the browser. */
  idTag?: string;
  /** Ivora token resource ID, once known. */
  tokenId?: number;
  cardBlocked: boolean;
  /**
   * Idempotency-Key of a block in progress: kept until the block succeeds so a
   * retry reuses it, then cleared so a later block is a new request.
   */
  blockKey?: string;
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

/** What the board shows about the latest profile change of a session. */
export interface ProfileState {
  /**
   * sending: written before the request. pending/accepted/rejected follow the
   * charger's answer; error is a failed request.
   */
  status: "sending" | "pending" | "accepted" | "rejected" | "error";
  /** Increases only when the plan changes; part of the idempotency key. */
  seq: number;
  key: string;
  kw: number;
  at: string;
  /** Ivora profile resource ID (chp_...). */
  profileId?: string;
  detail?: string;
  /** What the station reported it will apply (composite schedule). */
  composite?: string;
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
  /**
   * Profiles sent for this session that the station may be applying: every one
   * not known to be rejected, cleared or replaced. The site cap logic works from
   * these, not from what it planned.
   */
  sent?: SentProfile[];
  /**
   * Baseline on: what the charger's baseline let a new transaction draw when this
   * session was registered, W (counted until its own profile is in force).
   */
  startBaselineW?: number;
}

export interface SentProfile {
  /** Idempotency-Key of the POST, reused with the same body on a retry. */
  key: string;
  /** The exact body sent with `key`. */
  body: unknown;
  /** The highest limit in the body, W. */
  w: number;
  stack: number;
  /** Ivora profile resource ID (chp_...), once the API answered. */
  profileId?: string;
  /** The charger accepted it. */
  confirmed: boolean;
}

/**
 * A charger the depot has seen (live mode, baseline on). Its baseline is a
 * `tx_default` profile that limits a session until its own session profile is in force.
 */
export interface Charger {
  /** `st-<station ID>`. */
  id: string;
  stationId: number;
  protocol?: string;
  /**
   * The station's connectors, from `GET /stations/{id}`: the baseline covers all of
   * them. `maxW` is the connector rating (null when the station reports none). A
   * connector seen once stays in the split.
   */
  connectors: { id: number; maxW: number | null }[];
  /** Baseline profiles sent for this charger, counted like a session's. */
  sent?: SentProfile[];
  /** Number of the last baseline profile, for its idempotency key. */
  seq?: number;
  /** Random part of the idempotency keys, so they stay unique if the store is reset. */
  keyId: string;
  /** Each connector's share of the cap in the last plan, W. */
  shareW?: number;
  /** The cap and connector total that share was planned for. */
  plan?: string;
  /**
   * The charger rejected its baseline, or does not support it, under `plan`, at
   * `at`. It is not sent again until the plan changes or an hour has passed;
   * meanwhile the charger counts as having no baseline (its connectors are reserved
   * at their rating). An offline station or a dispatch error is not a refusal.
   */
  refused?: { plan?: string; why: string; at?: string };
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
  /** Live mode: keep a per-charger baseline profile (BASELINE_PROFILE). */
  baselineProfile?: boolean;
}
