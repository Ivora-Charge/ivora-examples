import "server-only";
import type { Command } from "./store";

/**
 * The payment hold before a START_SESSION. The start is sent to the CPO only after
 * `hold` succeeds, and a start that ends without charging (refused, not supported,
 * failed, timed out) calls `release` at once.
 *
 * Payments arrive in part 7, which replaces `stubPreAuth` in `preAuth()` with a card
 * hold. Until then the stub approves every start and holds nothing: run live mode only
 * on a private deployment. Tests install their own hook with setPreAuthForTests.
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
   * (no answer before the deadline); a session may still appear for this
   * authorization_reference, and part 7 decides how such a session is paid.
   */
  release(command: Command, why: { uncertain: boolean }): Promise<void>;
};

export const stubPreAuth: PreAuth = {
  async hold() {
    return { ok: true, reference: null };
  },
  async release() {},
};

const holder = globalThis as unknown as { __emspPreAuthOverride?: PreAuth };

/** The hook in use: the stub until part 7 replaces it here. */
export function preAuth(): PreAuth {
  return holder.__emspPreAuthOverride ?? stubPreAuth;
}

/** Tests only: use `hook` instead, or go back to the stub with undefined. */
export function setPreAuthForTests(hook: PreAuth | undefined) {
  holder.__emspPreAuthOverride = hook;
}
