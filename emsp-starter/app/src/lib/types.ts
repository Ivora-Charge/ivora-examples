/**
 * The shapes of the server's app API (see the server README, "Locations and tariffs"
 * and "Driver accounts and sign-in"). The app shares no code with the server, so they
 * are written out here; the offline demo data in `src/demo/locations.json` is made by
 * the server's own code, and a server test keeps it current.
 */
export type Mode = "demo" | "live";

export type EvseStatus =
  | "AVAILABLE"
  | "BLOCKED"
  | "CHARGING"
  | "INOPERATIVE"
  | "OUTOFORDER"
  | "PLANNED"
  | "REMOVED"
  | "RESERVED"
  | "UNKNOWN";

export type ConnectorStandard = string;

export type RegularHours = {
  weekday: number;
  period_begin: string;
  period_end: string;
};

export type OpeningTimes = {
  twentyfourseven: boolean;
  regular_hours?: RegularHours[];
  exceptional_openings?: { period_begin: string; period_end: string }[];
  exceptional_closings?: { period_begin: string; period_end: string }[];
};

export type DisplayText = { language: string; text: string };

export type PriceUnit = "kWh" | "hour" | "session";
export type PriceType = "ENERGY" | "TIME" | "PARKING_TIME" | "FLAT";

export type LeadPrice = {
  type: PriceType;
  unit: PriceUnit;
  /** Ten-thousandths of the currency's major unit: 4235 is €0.4235. */
  priceE4: number;
  vatIncluded: boolean;
};

export type DisplayComponent = LeadPrice & {
  /** The server's English text, for example "€0.35 per kWh". */
  text: string;
  /** When it applies, in English, for example ["Mon–Fri", "08:00–20:00"]. */
  conditions: string[];
};

export type DisplayPrice = {
  tariffId: string;
  currency: string;
  free: boolean;
  components: DisplayComponent[];
  minPrice?: string;
  maxPrice?: string;
  altText?: string;
  summary: string;
};

export type LocationSummary = {
  id: string;
  name: string;
  address: string;
  postal_code?: string;
  city: string;
  country: string;
  coordinates: { lat: number; lng: number };
  distance_m?: number;
  operator?: string;
  facilities: string[];
  parking_type?: string;
  time_zone: string;
  opening_times?: OpeningTimes;
  evse_count: number;
  available_count: number;
  /** EVSEs per status; older servers may not send it. */
  status_counts?: Partial<Record<EvseStatus, number>>;
  matching_evse_count: number;
  max_power_kw: number;
  connector_standards: ConnectorStandard[];
  price: {
    free: boolean;
    summary: string;
    currency?: string;
    lead?: LeadPrice;
  } | null;
  last_updated: string;
};

export type ConnectorDetail = {
  id: string;
  standard: ConnectorStandard;
  format: "SOCKET" | "CABLE";
  power_type: string;
  max_power_kw: number;
  price: DisplayPrice | null;
  terms_and_conditions?: string;
};

export type EvseDetail = {
  uid: string;
  evse_id?: string;
  status: EvseStatus;
  physical_reference?: string;
  floor_level?: string;
  capabilities: string[];
  parking_restrictions: string[];
  directions?: DisplayText[];
  connectors: ConnectorDetail[];
};

export type LocationDetail = LocationSummary & {
  directions?: DisplayText[];
  charging_when_closed?: boolean;
  evses: EvseDetail[];
};

export type SearchResult = {
  mode: Mode;
  items: LocationSummary[];
  total: number;
  limit: number;
  offset: number;
};

export type AuthSession = {
  accessToken: string;
  refreshToken: string;
  /** When the access token expires, ISO 8601. */
  expiresAt: string;
};

export type Driver = {
  id: string;
  email: string;
  status: string;
  hasCard: boolean;
  mode: Mode;
};
