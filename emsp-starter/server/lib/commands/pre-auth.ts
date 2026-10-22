import "server-only";
import { paymentsPreAuth } from "@/lib/payments/hold";
import type { Command } from "./store";

/**
 * The payment hold before a START_SESSION. The start is sent to the CPO only after
 * `hold` succeeds, and a start that ends without charging (refused, not supported,
 * failed, timed out) calls `release` at once.
 *
 * `preAuth()` is the card hold of lib/payments (paymentsPreAuth): a manual-capture
 * PaymentIntent on the driver's default card, captured later from the session's CDR.
 * Tests install their own hook with setPreAuthForTests.
 */
export type HoldResult =
  | { ok: true; reference: string | null }
  /** `reason` is shown to the driver: say what to do, never card data. */
  | { ok: false; reason: string };

export type PreAuth = {
  hold(command: Command): Promise<HoldResult>;
  /**
   * Releases the hold of a start that ended without charging. Must be safe to call when
   * no hold was placed, and more than once (a hold placed after the start timed out is
   * released again). `uncertain`: we never learnt whether the CPO started a session
   * (no answer before the deadline, or the CPO's CommandResult TIMEOUT); a session may
   * still appear for this authorization_reference: lib/payments keeps that hold a
   * while, and charges it from the session's CDR if one comes.
   */
  release(command: Command, why: { uncertain: boolean }): Promise<void>;
};

/** Approves every start and holds nothing. For tests that are not about payments. */
export const stubPreAuth: PreAuth = {
  async hold() {
    return { ok: true, reference: null };
  },
  async release() {},
};

const holder = globalThis as unknown as { __emspPreAuthOverride?: PreAuth };

/** The hook in use: card holds on the network's Stripe account (demo: none). */
export function preAuth(): PreAuth {
  return holder.__emspPreAuthOverride ?? paymentsPreAuth();
}

/** Tests only: use `hook` instead, or go back to the stub with undefined. */
export function setPreAuthForTests(hook: PreAuth | undefined) {
  holder.__emspPreAuthOverride = hook;
}
