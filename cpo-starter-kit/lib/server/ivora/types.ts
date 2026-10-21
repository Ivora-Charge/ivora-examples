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
  external_reference?: string | null;
}

export interface LocationInput {
  name: string;
  address?: string;
  city?: string;
  postal_code?: string;
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
  last_seen?: string | null;
  external_reference?: string | null;
  connectors: Connector[];
}

export interface Transaction {
  id: number;
  station_id: number | null;
  connector_id: number | null;
  /** The API may report null while the state is unknown. */
  active: boolean | null;
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
  listTransactions(o?: {
    limit?: number;
    station_id?: number;
  }): Promise<Transaction[]>;
  /** Replaces name, colour and support contacts; keeps the logo. */
  putBranding(input: BrandingInput, key: string): Promise<Branding>;
  /** Needs the branding to be set first. */
  putBrandingLogo(logo: LogoUpload, key: string): Promise<Branding>;
  getPaymentAccount(): Promise<PaymentAccount>;
}
