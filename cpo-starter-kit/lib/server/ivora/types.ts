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
  getTransaction(transactionId: number): Promise<Transaction>;
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
}
