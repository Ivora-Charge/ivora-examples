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
}
export interface State {
  demo: boolean;
  now: string;
  settings: { siteCapKw: number; currency: string; centsPerKwh: number };
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
}
export interface Report {
  currency: string;
  rows: {
    key: string;
    label: string;
    sessions: number;
    kwh: number;
    costCents: number;
  }[];
}
