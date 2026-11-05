/** The shapes /api/state and /api/reports return, as the browser uses them. */
export interface Profile {
  status: string;
  detail?: string;
  composite?: string;
}
export interface PublicSession {
  id: string;
  station: string;
  connector: number;
  allocatedKw: number;
  deliveredKwh: number;
  idTokenHint?: string;
  profile?: Profile;
}
export interface Vehicle {
  id: string;
  name: string;
  plate: string;
  kind?: string;
  batteryKwh: number;
  maxKw: number;
  driverId?: string;
  departure?: string;
  need?:
    { kind: "kwh"; kwh: number } | { kind: "battery"; targetPercent: number };
}
export interface Row {
  vehicle: Vehicle;
  driver?: string;
  session?: PublicSession;
  soc?: number;
  socReported: boolean;
  remainingKwh?: number;
  readyBy?: boolean;
  /** Demo only: the charger this vehicle is planned on. */
  plan?: {
    charger: string;
    outlet: number;
    outlets: number;
    type: "L2 AC" | "DC fast";
    ratedKw: number;
  };
  /** Demo only: still on its route. */
  notArrived?: boolean;
  /** Demo only: how the vehicle left (set once its session has ended at departure). */
  departed?: { ready: boolean; shortfallKwh: number };
}
export interface State {
  demo: boolean;
  now: string;
  /** Demo only: the depot's time zone ("UTC"); every demo time is shown in it. */
  tz?: string;
  settings: {
    siteCapKw: number;
    currency: string;
    centsPerKwh: number;
    tariffs?: {
      id: string;
      name: string;
      currency: string;
      minorPerKwh: number;
    }[];
  };
  totalKw: number;
  rows: Row[];
  unmatched: PublicSession[];
  drivers: {
    id: string;
    name: string;
    card?: string;
    cardBlocked: boolean;
    cardError?: string;
  }[];
  events: { id: string; at: string; type: string; detail: string }[];
  /** Demo only: the clock and the night's power history. */
  sim?: {
    speed: 0 | 1 | 60 | 300;
    /** The simulated time now, to the minute (the board moves in 5-minute steps). */
    at: number;
    start: number;
    end: number;
    done: boolean;
    peakKw: number;
    ghostPeakKw: number;
    /** Top of the power chart's axis, kW. */
    axisMaxKw: number;
    /** [epoch ms, actual kW, kW without load management] */
    samples: [number, number, number][];
  };
}
export interface Report {
  /** One list per currency: amounts in different currencies are never added together. */
  groups: {
    currency: string;
    rows: {
      key: string;
      label: string;
      sessions: number;
      kwh: number;
      costMinor: number;
    }[];
  }[];
}
