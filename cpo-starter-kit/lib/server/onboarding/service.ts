import "server-only";
import { createHash } from "node:crypto";
import type { z } from "zod";
import { driverPageColor } from "@/lib/brand-colors";
import { atLeast } from "@/lib/roles";
import { demoPaymentAccount } from "../ivora/demo";
import {
  describeError,
  idempotencyKey,
  IvoraError,
  type BrandingInput,
  type IvoraClient,
} from "../ivora";
import { checkLogo } from "./image";
import { colorInput, companyInput } from "./input";
import { stripeView, type StripeView } from "./stripe";
import {
  noCompany,
  notAllowed,
  OnboardingError,
  type CompanyProfile,
  type OnboardingStore,
} from "./types";
import type { Staff } from "../team/types";

// Onboarding rules, shared by demo and live mode. Every function that changes
// something checks the signed-in staff member is an owner or manager here, on the
// server, and the store checks it again in the same statement as the write. Logs carry
// error codes and request IDs only.

export interface OnboardingDeps {
  store: OnboardingStore;
  ivora: IvoraClient;
}

function requireManager(actor: Staff) {
  if (!atLeast(actor.role, "manager")) throw notAllowed();
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success)
    throw new OnboardingError(
      "invalid",
      r.error.issues[0]?.message ?? "Check the form and try again.",
    );
  return r.data;
}

const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

/**
 * What Ivora's driver pages should show, or null until there is a company name. A
 * brand colour below 3:1 on white goes as a darker, readable shade of itself.
 */
export function brandingPayload(p: CompanyProfile): BrandingInput | null {
  if (!p.name) return null;
  return {
    display_name: p.name,
    primary_color: p.primaryColor ? driverPageColor(p.primaryColor) : null,
    support_email: p.supportEmail,
    support_url: p.supportUrl,
  };
}

/** Stable digest of a branding payload (fixed key order). */
export function brandingHash(b: BrandingInput): string {
  return sha256(
    JSON.stringify([
      b.display_name,
      b.primary_color,
      b.support_email,
      b.support_url,
    ]),
  );
}

/** The driver pages show what the kit has saved. */
export function brandingInSync(p: CompanyProfile): boolean {
  const b = brandingPayload(p);
  return Boolean(b && p.brandingHash === brandingHash(b));
}

export const companyDone = (p: CompanyProfile) =>
  Boolean(p.name && p.supportEmail && p.timeZone && p.currency);

/** A brand colour is chosen and Ivora's driver pages show it. */
export const brandDone = (p: CompanyProfile) =>
  Boolean(p.primaryColor) && brandingInSync(p);

export type SyncResult =
  | { state: "synced" }
  | { state: "skipped" }
  | { state: "failed"; error: string };

function ivoraFailure(e: unknown, what: string): { error: string } {
  if (!(e instanceof IvoraError)) throw e;
  // Code and request ID only: never the key, tenant ID or response body.
  console.error(
    `cpo-starter-kit: ${what} failed:`,
    `${e.code} (HTTP ${e.status}) ${e.requestId ?? ""}`,
  );
  return { error: describeError(e) };
}

/**
 * Pushes the saved name, colour and support contacts to Ivora's driver pages
 * (`PUT /branding`). The Idempotency-Key is derived from the operator, the number of
 * pushes so far and the content: a retry of the same push reuses it, and a later push
 * of earlier content (A, B, then A again) gets a new one, so it is not answered with
 * the stored reply to the first. Skipped while there is no company name, and while
 * Ivora already shows the saved branding unless `force`.
 */
export async function syncBranding(
  d: OnboardingDeps,
  actor: Staff,
  o: { force?: boolean } = {},
): Promise<SyncResult> {
  requireManager(actor);
  const p = await d.store.load(actor.operatorId);
  const input = brandingPayload(p);
  if (!input) return { state: "skipped" };
  const hash = brandingHash(input);
  if (!o.force && p.brandingHash === hash) return { state: "synced" };
  const key = idempotencyKey(
    "branding",
    actor.operatorId,
    `put-${p.brandingSyncs}-${hash.slice(0, 16)}`,
  );
  let logoUrl: string | null;
  try {
    logoUrl = (await d.ivora.putBranding(input, key)).logo_url ?? null;
  } catch (e) {
    return { state: "failed", ...ivoraFailure(e, "branding push") };
  }
  await d.store.recordBranding(actor, { hash, logoUrl, logoUploaded: false });
  return { state: "synced" };
}

export type LogoResult =
  | { state: "uploaded" }
  | { state: "demo" }
  | { state: "failed"; error: string };

/** `PUT /branding/logo`, after the branding itself is on Ivora. */
async function uploadLogo(
  d: OnboardingDeps,
  actor: Staff,
  bytes: Uint8Array,
): Promise<LogoResult> {
  const logo = checkLogo(bytes);
  // Demo mode checks the image and stops: nothing is uploaded or kept.
  if (d.ivora.mode === "demo") return { state: "demo" };
  const p = await d.store.load(actor.operatorId);
  const key = idempotencyKey(
    "logo",
    actor.operatorId,
    `put-${p.logoUploads}-${sha256(bytes).slice(0, 16)}`,
  );
  let logoUrl: string | null;
  try {
    logoUrl = (await d.ivora.putBrandingLogo(logo, key)).logo_url ?? null;
  } catch (e) {
    return { state: "failed", ...ivoraFailure(e, "logo upload") };
  }
  await d.store.recordBranding(actor, {
    hash: null,
    logoUrl,
    logoUploaded: true,
  });
  return { state: "uploaded" };
}

/** Saves the company details, then pushes the driver-page branding to Ivora. */
export async function saveCompany(
  d: OnboardingDeps,
  actor: Staff,
  raw: Record<string, unknown>,
): Promise<{ sync: SyncResult }> {
  requireManager(actor);
  const input = parse(companyInput, raw);
  await d.store.saveCompany(actor, input);
  return { sync: await syncBranding(d, actor) };
}

/**
 * Saves the brand colour, pushes the branding, then uploads the logo if one was
 * chosen. The logo is checked before anything is saved, so a wrong file changes
 * nothing.
 */
export async function saveBrand(
  d: OnboardingDeps,
  actor: Staff,
  raw: { primaryColor: unknown; logo: Uint8Array | null },
): Promise<{ sync: SyncResult; logo: LogoResult | null }> {
  requireManager(actor);
  const color = parse(colorInput, raw.primaryColor);
  if (raw.logo?.length) checkLogo(raw.logo);
  const p = await d.store.load(actor.operatorId);
  if (!p.name) throw noCompany();
  await d.store.saveBrand(actor, color);
  const sync = await syncBranding(d, actor);
  if (!raw.logo?.length || sync.state !== "synced") return { sync, logo: null };
  return { sync, logo: await uploadLogo(d, actor, raw.logo) };
}

export type StripeResult =
  { ok: true; view: StripeView } | { ok: false; error: string };

/**
 * The Stripe account Ivora Checkout charges (`billing:read`). Demo mode shows the
 * state the visitor chose to simulate. The kit stores no Stripe keys: connecting
 * Stripe happens in the Ivora dashboard.
 */
export async function loadStripe(d: OnboardingDeps): Promise<StripeResult> {
  if (d.store.demoStripe)
    return {
      ok: true,
      view: stripeView(demoPaymentAccount(await d.store.demoStripe())),
    };
  try {
    return { ok: true, view: stripeView(await d.ivora.getPaymentAccount()) };
  } catch (e) {
    return { ok: false, ...ivoraFailure(e, "payment account read") };
  }
}

export interface Onboarding {
  profile: CompanyProfile;
  companyDone: boolean;
  brandDone: boolean;
  /** Ivora's driver pages show what is saved here. */
  inSync: boolean;
}

export async function loadOnboarding(
  d: OnboardingDeps,
  staff: Staff,
): Promise<Onboarding> {
  const profile = await d.store.load(staff.operatorId);
  return {
    profile,
    companyDone: companyDone(profile),
    brandDone: brandDone(profile),
    inSync: brandingInSync(profile),
  };
}
