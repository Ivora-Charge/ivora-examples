import "server-only";
import { z } from "zod";
import { atLeast } from "@/lib/roles";
import { DEMO_STRIPE_STATES, type DemoStripeState } from "../ivora/demo";
import {
  emptyProfile,
  noCompany,
  notAllowed,
  type CompanyProfile,
  type OnboardingStore,
} from "./types";

// Demo onboarding: each visitor's company details, brand and simulated Stripe state
// live in their own cookie (see demo-cookie.ts), so visitors never see each other's
// changes and nothing is sent anywhere.

const text = (max: number) => z.string().max(max).nullable();
const stateSchema = z.object({
  v: z.literal(1),
  profile: z.object({
    name: text(80),
    supportEmail: text(254),
    supportUrl: text(300),
    website: text(300),
    timeZone: text(64),
    currency: text(3),
    primaryColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/)
      .nullable(),
    logoUrl: z
      .url({ protocol: /^https$/ })
      .max(2048)
      .nullable(),
    brandingHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    brandingSyncedAt: text(40),
    brandingSyncs: z.number().int().min(0),
    logoUploads: z.number().int().min(0),
  }),
  stripe: z.enum(DEMO_STRIPE_STATES),
});
export type DemoOnboardingState = z.infer<typeof stateSchema>;

export function demoOnboardingSeed(): DemoOnboardingState {
  return {
    v: 1,
    profile: emptyProfile(),
    stripe: "none",
  };
}

export function decodeDemoOnboarding(
  raw: string | undefined,
): DemoOnboardingState {
  if (!raw) return demoOnboardingSeed();
  try {
    const parsed = stateSchema.safeParse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : demoOnboardingSeed();
  } catch {
    return demoOnboardingSeed();
  }
}

export function encodeDemoOnboarding(s: DemoOnboardingState): string {
  return Buffer.from(JSON.stringify(s), "utf8").toString("base64url");
}

export interface DemoOnboardingCookie {
  load(): Promise<DemoOnboardingState>;
  save(s: DemoOnboardingState): Promise<void>;
}

export function memoryDemoOnboarding(
  initial = demoOnboardingSeed(),
): DemoOnboardingCookie & { state: DemoOnboardingState } {
  const store = {
    state: structuredClone(initial),
    async load() {
      return structuredClone(store.state);
    },
    async save(s: DemoOnboardingState) {
      store.state = structuredClone(s);
    },
  };
  return store;
}

/** The demo store: same rules as live (owners and managers only), no network. */
export function createDemoOnboardingStore(
  cookie: DemoOnboardingCookie,
): OnboardingStore {
  const update = async (
    actor: { role: Parameters<typeof atLeast>[0] },
    change: (p: CompanyProfile) => void,
  ) => {
    if (!atLeast(actor.role, "manager")) throw notAllowed();
    const s = await cookie.load();
    change(s.profile);
    await cookie.save(s);
  };
  return {
    mode: "demo",
    async load() {
      return (await cookie.load()).profile;
    },
    saveCompany(actor, input) {
      return update(actor, (p) => Object.assign(p, input));
    },
    saveBrand(actor, primaryColor) {
      return update(actor, (p) => {
        p.primaryColor = primaryColor;
      });
    },
    recordBranding(actor, r) {
      return update(actor, (p) => {
        if (!p.name) throw noCompany();
        if (r.hash) {
          p.brandingHash = r.hash;
          p.brandingSyncedAt = new Date().toISOString();
          p.brandingSyncs += 1;
        }
        // Always null with the demo client, which never uploads a logo.
        p.logoUrl = r.logoUrl;
        if (r.logoUploaded) p.logoUploads += 1;
      });
    },
    async demoStripe() {
      return (await cookie.load()).stripe;
    },
    async setDemoStripe(state: DemoStripeState) {
      const s = await cookie.load();
      s.stripe = state;
      await cookie.save(s);
    },
  };
}
