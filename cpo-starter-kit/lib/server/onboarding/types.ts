import "server-only";
import type { DemoStripeState } from "../ivora/demo";
import type { Staff } from "../team/types";

/** The operator's company details and brand, as saved in the kit. */
export interface CompanyProfile {
  /** The name drivers see on Ivora's payment pages. */
  name: string | null;
  supportEmail: string | null;
  /** https only. */
  supportUrl: string | null;
  website: string | null;
  /** IANA time zone, for showing UTC timestamps in local time. */
  timeZone: string | null;
  /** ISO 4217, for prices and reports (amounts stay in integer minor units). */
  currency: string | null;
  /** #rrggbb. */
  primaryColor: string | null;
  /** The logo as Ivora serves it. The kit never stores the image. */
  logoUrl: string | null;
  /** SHA-256 of the branding last pushed to Ivora. */
  brandingHash: string | null;
  brandingSyncedAt: string | null;
  /** Pushes and uploads so far: part of the next Idempotency-Key. */
  brandingSyncs: number;
  logoUploads: number;
}

export interface CompanyInput {
  name: string;
  supportEmail: string;
  supportUrl: string | null;
  website: string | null;
  timeZone: string;
  currency: string;
}

/** What Ivora answered after a push or an upload. */
export interface BrandingRecord {
  /** Hash of the branding now live; null when only the logo was uploaded. */
  hash: string | null;
  logoUrl: string | null;
  logoUploaded: boolean;
}

/**
 * Where the company profile is kept. The Supabase store calls database functions that
 * check the actor is still an owner or manager in the same statement as the write; the
 * demo store keeps the profile in the visitor's cookie and sends nothing anywhere.
 */
export interface OnboardingStore {
  readonly mode: "live" | "demo";
  load(operatorId: string): Promise<CompanyProfile>;
  saveCompany(actor: Staff, input: CompanyInput): Promise<void>;
  saveBrand(actor: Staff, primaryColor: string | null): Promise<void>;
  recordBranding(actor: Staff, r: BrandingRecord): Promise<void>;
  /** Demo mode only: the Stripe account state the visitor chose to simulate. */
  demoStripe?(): Promise<DemoStripeState>;
  setDemoStripe?(state: DemoStripeState): Promise<void>;
}

export type OnboardingErrorCode =
  "invalid" | "not_allowed" | "no_company" | "logo_invalid";

/** An error staff can act on. The message is safe to show. */
export class OnboardingError extends Error {
  constructor(
    public code: OnboardingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OnboardingError";
  }
}

export const notAllowed = () =>
  new OnboardingError(
    "not_allowed",
    "Only owners and managers can change the company details and brand. If your role just changed, reload the page.",
  );

export const noCompany = () =>
  new OnboardingError(
    "no_company",
    "Save your company details first: drivers need a name to see.",
  );

export function emptyProfile(): CompanyProfile {
  return {
    name: null,
    supportEmail: null,
    supportUrl: null,
    website: null,
    timeZone: null,
    currency: null,
    primaryColor: null,
    logoUrl: null,
    brandingHash: null,
    brandingSyncedAt: null,
    brandingSyncs: 0,
    logoUploads: 0,
  };
}
