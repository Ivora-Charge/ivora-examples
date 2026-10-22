import "server-only";

// Shapes follow the published OpenAPI (https://api.ivoracharge.com/openapi.json).
// Only the fields this template reads are listed.

export interface Page<T> {
  data: T[];
  /** Pass as `after` for the next page. Absent, null or 0 on the last page. */
  next_cursor?: number | null;
}

/** Every page of a list, up to a ceiling; `truncated` says the ceiling was hit. */
export interface Listed<T> {
  data: T[];
  truncated: boolean;
}

export interface Location {
  id: number;
  name: string;
  address?: string | null;
  city?: string | null;
  postal_code?: string | null;
  country?: string | null;
  /** WGS 84 degrees, when set: the Live map places the site with them. */
  latitude?: number | null;
  longitude?: number | null;
  /** IANA time zone of the site, when set: reports show its local times in it. */
  time_zone?: string | null;
  external_reference?: string | null;
}

export interface LocationInput {
  /** 2 to 80 characters. */
  name: string;
  address?: string;
  city?: string;
  postal_code?: string;
  /** Three letters (ISO 3166-1 alpha-3), for example USA. */
  country?: string;
  /** Derived from our own record, so a retry finds the record instead of duplicating it. */
  external_reference: string;
}

export interface Connector {
  id: number;
  number: number | null;
  status?: string | null;
  max_power_w?: number | null;
  /**
   * The connector's tariff in Ivora (charger screens show its price). Read-only
   * through the API: the kit bills with its own assignment (see lib/server/pricing).
   */
  tariff_id?: number | null;
}

export interface Station {
  id: number;
  name: string;
  online: boolean;
  location_id?: number | null;
  protocol?: string | null;
  vendor?: string | null;
  model?: string | null;
  /** Time of the charger's most recent OCPP message (heartbeats included). */
  last_seen?: string | null;
  external_reference?: string | null;
  /** The OCPP WebSocket URL the charger connects to. */
  connection_url?: string | null;
  /** The Basic authentication username the charger sends (its name). */
  username?: string | null;
  connectors: Connector[];
  /** The station's own position, if set; else its location's applies. */
  latitude?: number | null;
  longitude?: number | null;
  /** Faults still open, from the charger's status notifications; history at /faults. */
  open_faults?: Fault[] | null;
}

/**
 * A fault from the charger's status notifications (an OCPP 1.6 errorCode other than
 * NoError, or status Faulted). Open until a later notification clears it.
 */
export interface Fault {
  /** fault_id in station.fault_opened and station.fault_cleared events. */
  id: string;
  station_id: number;
  /** Connector resource ID; null when reported for the whole station. */
  connector_id: number | null;
  open: boolean;
  /** OCPP 1.6 errorCode; null for an OCPP 2.x Faulted status without one. */
  error_code: string | null;
  info?: string | null;
  vendor_error_code?: string | null;
  ocpp_status?: string | null;
  opened_at: string;
  cleared_at: string | null;
}

/** `POST /stations`. Registration does not connect hardware; set credentials next. */
export interface StationInput {
  /** Globally unique OCPP connection name: ^[a-zA-Z0-9][a-zA-Z0-9_-]{2,35}$. */
  name: string;
  location_id: number;
  /** 1 to 8. */
  connectors: number;
  /** Derived from our own record, so a retry finds the record instead of duplicating it. */
  external_reference: string;
}

/** `PATCH /stations/{id}`: only the supplied fields change. */
export interface StationUpdate {
  /** Move the station to another location of this tenant. */
  location_id?: number;
}

/**
 * What a command, credentials change or station edit returns (`202`). `succeeded`
 * means the core sent it; `result.charger_status` carries the charger's own answer.
 */
export interface Operation {
  id: string;
  status: "dispatching" | "succeeded" | "rejected" | "unknown";
  result: Record<string, unknown> | null;
  created_at?: string;
}

/**
 * The commands the kit sends: remote start and stop (the charger test and the Live
 * view), reset and unlock (the Live view). Connector IDs are resource IDs from the
 * station, never OCPP connector numbers.
 */
export type CommandInput =
  | {
      action: "start";
      connector_id: number;
      token: string;
      token_type: "Central";
    }
  | { action: "stop"; transaction_id: number }
  | { action: "reset"; mode: "soft" | "hard" }
  | { action: "unlock"; connector_id: number };

/** An ID token in the operator's Ivora token list (`/tokens`). */
export interface TokenRecord {
  id: number;
  id_token: string;
  type?: string | null;
  status: "Accepted" | "Blocked" | "Expired" | (string & {});
  label?: string | null;
  external_reference?: string | null;
}

/** `POST /tokens`: registers an ID token, found again by its external_reference. */
export interface TokenInput {
  id_token: string;
  type: "Central";
  status: "Accepted";
  label: string;
  /** Derived from our own record, so a retry finds the token instead of duplicating it. */
  external_reference: string;
}

export interface Transaction {
  id: number;
  station_id: number | null;
  connector_id: number | null;
  /** The API may report null while the state is unknown. */
  active: boolean | null;
  connector_number?: number | null;
  /** The ID token the session started with; the API masks it to its last 4 characters behind ****. */
  id_token?: string | null;
  started_at: string | null;
  ended_at: string | null;
  energy_wh?: number | null;
}

/** The bill a transaction settles, as `GET /transactions/{id}` shows it. */
export interface TransactionBill {
  id: string;
  status: "open" | "final";
  currency: string;
  /** Final amount in integer minor units; null while open. */
  total_minor: number | null;
  finalized_at?: string | null;
}

/**
 * `GET /transactions/{id}` (needs billing:read): the session with its stop reason,
 * duration and bill. The list (`GET /transactions`) carries none of these, has no date
 * filter and lists oldest first, so reports never scan it for a period.
 */
export interface TransactionDetail extends Transaction {
  /** The station's OCPP connection name. */
  station_name?: string | null;
  /** From started_at to ended_at, or until now while the session is active. */
  duration_seconds?: number | null;
  stop_reason?: string | null;
  bill?: TransactionBill | null;
}

// ---- Overview statistics (`GET /stats`) ----

export type StatsBucketSize = "hour" | "day" | "month";

export interface StatsQuery {
  /** ISO 8601 with an offset (the kit sends UTC). */
  from: string;
  /** ISO 8601, exclusive. */
  to: string;
  bucket: StatsBucketSize;
  /** IANA time zone of the bucket boundaries. */
  time_zone: string;
  /** Top stations, 1 to 20. */
  top: number;
}

/** Billed revenue in one currency: final bills' total_minor, never captures or refunds. */
export interface RevenueLine {
  currency: string;
  billed_minor: number;
  bills: number;
}

/** Session figures of the period or of one bucket. */
export interface StatsFigures {
  sessions: number;
  ended_sessions: number;
  successful_sessions: number;
  /** successful / ended as decimal text with 4 places ("0.9500"); null when none ended. */
  success_rate: string | null;
  average_duration_seconds: number | null;
  /** kWh as decimal text, summed exactly. */
  energy_kwh: string;
  energy_wh: number;
}

export interface StatsTotals extends StatsFigures {
  active_sessions: number;
  energy_unknown_sessions: number;
}

export interface StatsBucket extends StatsFigures {
  /** Bucket start and end (exclusive), ISO 8601 in the requested time zone. */
  start: string;
  end: string;
  /** Final bills finalized in the bucket; null without billing:read. */
  revenue: RevenueLine[] | null;
}

export interface TopStation {
  station_id: number;
  /** Null for a station deleted since. */
  name: string | null;
  sessions: number;
  energy_kwh: string;
  energy_wh: number;
}

/** Station state now (not for the period), cached up to 30 seconds by Ivora. */
export interface StationCounts {
  as_of: string;
  total: number;
  online: number;
  offline: number;
  faulted: number;
}

export interface Stats {
  bucket: StatsBucketSize;
  time_zone: string;
  /** The period, widened to whole buckets. */
  start: string;
  end: string;
  sessions_as_of: string;
  totals: StatsTotals;
  /** Oldest first, empty buckets included. */
  series: StatsBucket[];
  top_stations: TopStation[];
  stations: StationCounts;
  /** Final bills by finalized_at, per currency; null without billing:read. */
  revenue: { basis: "final_bills"; currencies: RevenueLine[] } | null;
}

/**
 * One item of `GET /transactions`. The list runs oldest first (page on with `after`,
 * a transaction ID) and its items carry no ID token or connector: read
 * `GET /transactions/{id}` for those.
 */
/** Limits for a read that is part of a larger budget (Live's session tracking). */
export interface ReadLimits {
  /** Epoch ms: no try and no wait between tries goes past it. */
  deadline?: number;
  /** A 429 comes back at once with its Retry-After, instead of being waited out. */
  failOn429?: boolean;
}

export type TransactionListItem = Pick<Transaction, "id"> &
  Partial<
    Pick<Transaction, "station_id" | "active" | "started_at" | "ended_at">
  >;

/** `PUT /v1/tenants/{id}/branding`: what drivers see on Ivora's payment pages. */
export interface BrandingInput {
  /** 1 to 80 characters. */
  display_name: string;
  /** #rrggbb; null keeps the driver pages' default colour. */
  primary_color: string | null;
  support_email: string | null;
  /** An https page where drivers get help. */
  support_url: string | null;
}

export interface Branding {
  display_name: string;
  /** Null when no logo is set: drivers see the name as text. */
  logo_url: string | null;
  primary_color: string | null;
  support_email: string | null;
  support_url: string | null;
  /** True while the tenant has set no branding: drivers see Ivora's. */
  is_default: boolean;
  updated_at?: string | null;
}

/** `PUT /v1/tenants/{id}/branding/logo`: the raw image, at most 512 KB. */
export interface LogoUpload {
  bytes: Uint8Array;
  contentType: "image/png" | "image/jpeg" | "image/webp";
}

/**
 * `GET /payment/stripe/v1/tenants/{id}/account`: the Stripe Connect account Ivora
 * Checkout charges. Connecting it happens in the Ivora dashboard (API keys can't
 * create onboarding links); the kit only reads it and stores no Stripe keys.
 */
export interface PaymentAccount {
  /** none or disconnected: no account. pending_review: awaiting Ivora's approval. */
  status: "none" | "pending_review" | "active" | "disconnected" | (string & {});
  stripe_account_id?: string | null;
  charges_enabled?: boolean;
  details_submitted?: boolean;
  disabled_reason?: string | null;
  requirements_due?: string[];
  livemode?: boolean | null;
}

// ---- Tariffs (OCPI 2.2.1-aligned elements) ----

export type PriceDimension = "ENERGY" | "TIME" | "PARKING_TIME" | "FLAT";

export interface PriceComponent {
  type: PriceDimension;
  /** Major units excluding tax, at most 4 decimals (OCPI): 0.35 is $0.35 per kWh. */
  price: number;
  /** ENERGY in Wh, TIME and PARKING_TIME in seconds; ignored for FLAT. */
  step_size?: number;
}

export type DayOfWeek =
  | "MONDAY"
  | "TUESDAY"
  | "WEDNESDAY"
  | "THURSDAY"
  | "FRIDAY"
  | "SATURDAY"
  | "SUNDAY";

/** The OCPI restrictions the kit uses: local time of day and days of the week. */
export interface TariffRestrictions {
  /** HH:MM local time, inclusive. */
  start_time?: string;
  /** HH:MM local time, exclusive; before start_time wraps midnight. */
  end_time?: string;
  day_of_week?: DayOfWeek[];
}

export interface TariffElement {
  price_components: PriceComponent[];
  restrictions?: TariffRestrictions | null;
}

/** Driver-facing description (OCPI tariff_alt_text). */
export interface AltText {
  /** ISO 639-1. */
  language: string;
  /** 1 to 512 characters. */
  text: string;
}

/**
 * Ivora billing rules, applied after the elements in billing only (never published
 * over OCPI). The kit uses one: free idle minutes.
 */
export interface BillingRules {
  /**
   * PARKING_TIME is charged only for idle time beyond the first N minutes of each
   * session. Newer than the published OpenAPI: an API without it refuses the field
   * (so the kit checks a simulation applies it before offering a grace period).
   */
  idle_grace_minutes?: number;
}

/** A tariff definition, as `POST /tariffs/simulate` takes it (no hold, no reference). */
export interface TariffDefinitionInput {
  currency: string;
  elements: TariffElement[];
  tariff_alt_text: AltText[];
  /** IANA time zone of the restrictions' local times. */
  time_zone: string;
  /** Sent only when the kit uses a rule (an idle grace period). */
  rules?: BillingRules;
}

/** `POST /tariffs`: a new tariff, found again by its external_reference. */
export interface TariffInput extends TariffDefinitionInput {
  /** Integer minor units held before charging. */
  authorization_minor: number;
  /** Derived from our own record and version, so a retry finds the tariff. */
  external_reference: string;
}

export interface Tariff {
  id: number;
  currency: string;
  /** The base rate (the last unrestricted ENERGY price), integer minor units per kWh. */
  rate_minor_per_kwh: number;
  authorization_minor: number;
  archived?: boolean;
  external_reference?: string | null;
  is_complex?: boolean;
  /** The English driver-facing description. */
  pricing_summary?: string | null;
}

/** What `DELETE /tariffs/{id}` answers: the archived tariff and what moved off it. */
export interface TariffArchived {
  id: number;
  archived: true;
  replacement_tariff_id: number | null;
  /** Connector resource IDs moved to the replacement. */
  reassigned_connectors: number[];
}

/** A session to price. Energy spreads evenly over the charging time. */
export interface SessionProfile {
  /** ISO 8601 with an offset. */
  start_at: string;
  /** IANA time zone for local-time restrictions. */
  time_zone: string;
  /** Charging time in minutes. */
  duration_minutes: number;
  energy_kwh: number;
  /**
   * Minutes connected after charging ends (PARKING_TIME is billed on them, less any
   * free minutes of rules.idle_grace_minutes).
   */
  idle_minutes: number;
}

export interface QuoteLine {
  type: PriceDimension;
  /** Index of the element that priced this line. */
  element: number;
  reservation: boolean;
  /** Decimal quantity in `unit`. */
  quantity: string;
  unit: "kWh" | "h" | "session";
  /** Minor units per unit, as a decimal string. */
  price_minor: string;
  /** Unrounded amount, minor units (decimal string). */
  exact_minor: string;
  /** Rounded half up, for display; the total rounds the exact sum once. */
  amount_minor: number;
}

export interface QuoteAdjustment {
  kind: string;
  rule: string;
  exact_minor: string;
  amount_minor: number;
}

/** `POST /tariffs/simulate` and `/quote`: the same calculation bills finalize with. */
export interface Quote {
  tariff_id?: number | null;
  currency: string;
  pricing_version: string;
  lines: QuoteLine[];
  subtotal_minor: number;
  exact_subtotal_minor: string;
  adjustments: QuoteAdjustment[];
  /** Integer minor units: the exact subtotal after rules, rounded half up once. */
  total_minor: number;
  tariff_alt_text?: AltText[];
  /**
   * With rules.idle_grace_minutes: the idle seconds that were free. Absent otherwise,
   * and from an API that does not apply the rule.
   */
  idle_free_seconds?: number;
}

// ---- OCPI publishing (roaming placeholder) ----

/** A party: the country of the registry that issued it and its 3-character party ID. */
export interface OcpiPartyRef {
  /** ISO 3166-1 alpha-2, capitals, for example US. */
  country_code: string;
  /** Three capital letters or digits. */
  party_id: string;
}

/** The party locations publish under now. */
export interface OcpiParty extends OcpiPartyRef {
  /** True for Ivora's shared party US*IVR. */
  shared: boolean;
}

/** The operator's own party request and Ivora's decision on it. */
export interface OcpiOwnParty extends OcpiPartyRef {
  /**
   * approved: locations publish under it. pending_approval or rejected: they publish
   * under the shared party with the operator's display name.
   */
  status: "approved" | "pending_approval" | "rejected" | (string & {});
  /** Why Ivora rejected the pair, while status is rejected. */
  rejection_note: string | null;
}

/** Connector facts for connectors with no hardware data (OCPI 2.2.1 values). */
export interface OcpiConnectorDefaults {
  standard: string;
  format: string;
  power_type: string;
  max_voltage: number;
  max_amperage: number;
}

/** `GET /v1/tenants/{id}/ocpi`. */
export interface OcpiSettings {
  /** The operator's choice; off by default. */
  publish: boolean;
  /** Ivora keeps this tenant private: never published, and publish: true is refused. */
  private: boolean;
  /** Whether partners receive the locations now. */
  published: boolean;
  display_name: string | null;
  website: string | null;
  time_zone: string | null;
  /** Stored defaults merged over the Level 2 ones. */
  connector_defaults: OcpiConnectorDefaults;
  excluded_location_ids: number[];
  own_party: OcpiOwnParty | null;
  party: OcpiParty;
  /** Null where this Ivora environment serves no OCPI yet. */
  versions_url: string | null;
  updated_at: string | null;
}

/** `PUT /v1/tenants/{id}/ocpi` replaces every setting: always send the whole object. */
export interface OcpiSettingsInput {
  publish: boolean;
  /** 1 to 100 characters; needed to publish. */
  display_name: string | null;
  /** https only. */
  website: string | null;
  /** IANA zone for locations without their own. */
  time_zone: string | null;
  connector_defaults: Partial<OcpiConnectorDefaults> | null;
  /** At most 1000. */
  excluded_location_ids: number[];
  /** Null publishes under Ivora's shared party. US*IVR itself is refused. */
  own_party: OcpiPartyRef | null;
}

/** An EVSE ID imported from the operator's previous CSMS. */
export interface OcpiEvseId {
  station_id: number;
  evse_number: number;
  evse_id: string;
  /** Whether partners receive this ID now (its party is the one in use). */
  applies: boolean;
  updated_at?: string | null;
}

/** `GET /v1/tenants/{id}/ocpi/evse-ids`. */
export interface OcpiEvseIds {
  party: OcpiParty;
  data: OcpiEvseId[];
}

// ---- Bills and Ivora Checkout (managed Stripe payments) ----

/** `POST /bills`: snapshots the tariff before charging. Usage comes from the charger. */
export interface BillInput {
  station_id: number;
  /** Connector resource ID, never the OCPP connector number. */
  connector_id: number;
  tariff_id: number;
}

/** The driver-facing step of a managed bill (single bill reads only). */
export type BillProgress =
  | "awaiting_payment"
  | "authorized"
  | "starting"
  | "waiting_for_vehicle"
  | "charging"
  | "ended"
  | "start_failed"
  | "canceled";

/** The matched transaction once a start was dispatched; a final snapshot once final. */
export interface BillUsage {
  transaction_id: number | null;
  active: boolean;
  /** Integer Wh for arithmetic. */
  energy_wh: number | null;
  /** Integer minor units; equals total_minor on a final bill. */
  estimated_minor: number | null;
  started_at: string | null;
  ended_at: string | null;
  /** Latest reported charging power, W; 0 once ended; null when not reported. */
  power_w?: number | null;
}

/**
 * A bill. Its `charging_token` is deliberately not listed: the kit never reads, stores
 * or shows it.
 */
export interface Bill {
  id: string;
  station_id: number;
  connector_id: number;
  tariff_id: number;
  hold_minor: number;
  currency: string;
  status: "open" | "final";
  total_minor: number | null;
  transaction_id: number | null;
  created_at: string;
  finalized_at: string | null;
  usage?: BillUsage | null;
  start_operation?: Operation | null;
  /** Null for externally settled bills and in lists. */
  progress?: BillProgress | null;
}

/**
 * `POST /payment/stripe/…/payments`: a hosted authorization for a bill. With
 * return_surface driver, Stripe Checkout returns the driver to Ivora's driver page for
 * the bill's station and connector (URLs chosen by the API), which resumes the session
 * named by return_reference.
 */
export interface PaymentInput {
  bill_id: string;
  return_surface: "driver";
  /** ^[A-Za-z0-9_-]{1,128}$: our own session record, never a URL. */
  return_reference: string;
}

export interface Payment {
  id: string;
  bill_id: string;
  status:
    | "preparing"
    | "pending"
    | "authorized"
    | "captured"
    | "canceled"
    | "refund_pending"
    | "refund_failed"
    | "refunded"
    | (string & {});
  hold_minor: number;
  /** Integer minor units captured (0 until captured, and for a waived bill). */
  captured_minor?: number;
  refunded_minor?: number;
  currency?: string;
  payment_mode: "test" | "live" | (string & {});
  authorized_at?: string | null;
  /** The hosted checkout the driver completes (see checkoutUrl in lib/server/checkout). */
  next_action: Record<string, unknown> | null;
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
  /** One page (up to 100). */
  listLocations(o?: ListOptions): Promise<Location[]>;
  /** Every page, up to MAX_LIST_PAGES pages. */
  listAllLocations(): Promise<Listed<Location>>;
  createLocation(input: LocationInput, key: string): Promise<Location>;
  listStations(o?: ListOptions): Promise<Station[]>;
  listAllStations(): Promise<Listed<Station>>;
  getStation(stationId: number): Promise<Station>;
  /** Adopts the station by external_reference when the create may already have happened. */
  createStation(input: StationInput, key: string): Promise<Station>;
  updateStation(
    stationId: number,
    input: StationUpdate,
    key: string,
  ): Promise<Operation>;
  /**
   * Deletes a station that never charged (a connected one is disconnected first).
   * One with charging history answers 409 station_has_history and stays in Ivora.
   */
  deleteStation(stationId: number, key: string): Promise<void>;
  /**
   * Sets the OCPP connection password. Offline stations store it for their next
   * connection; a connected OCPP 1.6 station answers station_online.
   */
  setCredentials(
    stationId: number,
    password: string,
    key: string,
  ): Promise<Operation>;
  sendCommand(
    stationId: number,
    command: CommandInput,
    key: string,
  ): Promise<Operation>;
  /** Reads an operation without sending it again. */
  getOperation(operationId: string): Promise<Operation>;
  listTransactions(o?: {
    limit?: number;
    station_id?: number;
  }): Promise<Transaction[]>;
  /**
   * One page of `GET /transactions`, oldest first: transactions with an ID above
   * `after` (lib/server/live/transactions.ts follows it from a stored high-water mark).
   */
  listTransactionsAfter(
    o: {
      station_id: number;
      after: number;
      limit?: number;
    },
    limits?: ReadLimits,
  ): Promise<Page<TransactionListItem>>;
  getTransaction(
    transactionId: number,
    limits?: ReadLimits,
  ): Promise<TransactionDetail>;
  /** The token with this external_reference, if any (`GET /tokens`). */
  findToken(externalReference: string): Promise<TokenRecord | null>;
  /** Adopts the token by external_reference when the create may already have happened. */
  createToken(input: TokenInput, key: string): Promise<TokenRecord>;
  /** Open and recent faults of one station, newest first (cleared ones kept 90 days). */
  listFaults(
    stationId: number,
    o?: { limit?: number; open?: boolean },
  ): Promise<Fault[]>;
  /** Replaces name, colour and support contacts; keeps the logo. */
  putBranding(input: BrandingInput, key: string): Promise<Branding>;
  /** Needs the branding to be set first. */
  putBrandingLogo(logo: LogoUpload, key: string): Promise<Branding>;
  getPaymentAccount(): Promise<PaymentAccount>;
  /**
   * Creates a tariff (a new version of one of the kit's tariffs). Adopts it by
   * external_reference when the create may already have happened.
   */
  createTariff(input: TariffInput, key: string): Promise<Tariff>;
  /** The tariff with this external_reference (archived ones too), if any. */
  findTariff(externalReference: string): Promise<Tariff | null>;
  /**
   * Archives a tariff: bills that snapshot it keep its price. With a replacement,
   * Ivora first moves the connectors and charger displays that use it.
   */
  archiveTariff(
    tariffId: number,
    replacementTariffId: number | null,
    key: string,
  ): Promise<TariffArchived>;
  /**
   * Validates a draft tariff like creation does (422 tariff_invalid with every problem
   * in details.errors) and prices the session with the billing function. Stores
   * nothing.
   */
  simulateTariff(
    tariff: TariffDefinitionInput,
    session: SessionProfile,
  ): Promise<Quote>;
  /** OCPI publishing settings (roaming placeholder). */
  getOcpiSettings(): Promise<OcpiSettings>;
  /** Replaces every OCPI setting; omitted fields return to their defaults. */
  putOcpiSettings(input: OcpiSettingsInput, key: string): Promise<OcpiSettings>;
  /** EVSE IDs imported from a previous CSMS (read only in the kit). */
  getOcpiEvseIds(): Promise<OcpiEvseIds>;
  /**
   * Prices a session under a stored tariff (`POST /tariffs/{id}/quote`), with the
   * function bills finalize with. Read-only: stores nothing, contacts no charger.
   */
  quoteTariff(tariffId: number, session: SessionProfile): Promise<Quote>;
  /** Snapshots the tariff in a new bill. Bills have no external_reference: keep the key. */
  createBill(input: BillInput, key: string): Promise<Bill>;
  /**
   * One bill with its usage, start operation and progress. For a driver-return payment
   * this read also asks Stripe and, once authorized, starts the charger once (the key
   * holds billing:write and stations:control).
   */
  getBill(billId: string): Promise<Bill>;
  /**
   * Starts an authorized bill whose automatic start was refused (`progress`
   * authorized). Answers with the bill's one start operation, whatever the key.
   */
  startBill(billId: string, key: string): Promise<Operation>;
  /** One payment per bill: a retry with the same key answers with the same payment. */
  createPayment(input: PaymentInput, key: string): Promise<Payment>;
  /** One tariff by its Ivora ID (its authorization_minor is the card hold). */
  getTariff(tariffId: number): Promise<Tariff>;
  /**
   * Finalizes a bill from its completed transaction (`POST /bills/{id}/finalize`).
   * Ivora reads the usage itself and computes the immutable total_minor.
   */
  finalizeBill(
    billId: string,
    transactionId: number,
    key: string,
  ): Promise<Bill>;
  /** One payment, synchronized with Stripe. */
  getPayment(paymentId: string): Promise<Payment>;
  /**
   * Captures exactly the final bill (no amount is sent). Zero bills, and bills below
   * Stripe's 50-cent minimum, release the hold instead (status canceled, captured 0).
   * A bill above its hold answers 409 bill_exceeds_hold.
   */
  capturePayment(paymentId: string, key: string): Promise<Payment>;
  /**
   * Releases an unused authorization. Stops no charger; after a dispatched start it
   * answers start_reserved until the start can no longer produce a session.
   */
  releasePayment(paymentId: string, key: string): Promise<Payment>;
  /** Records that the kit stopped charging near the hold (once per bill). */
  recordHoldStop(billId: string, key: string): Promise<void>;
  /**
   * Overview statistics (`GET /stats`): sessions, energy, success rate, average
   * duration, a series, top stations, station state and billed revenue. More than
   * 168 hour, 92 day or 24 month buckets, or 50,000 sessions, answers 422
   * stats_range_too_large.
   */
  getStats(q: StatsQuery): Promise<Stats>;
}
