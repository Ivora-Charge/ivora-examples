import "server-only";
import { configErrors, missingForLive } from "./config";

/**
 * The demo-mode switch. This file is the one place that decides whether the server
 * may talk to anything outside itself.
 *
 * Demo mode is on when DEMO_MODE=true (or 1), when any live-mode variable is missing,
 * or when a set value is invalid. In demo mode the server uses its built-in mock CPO
 * and sample data: it never charges a card, never sends an OCPI command or request to
 * a real CPO, and never sends email or push notifications.
 *
 * Every outbound HTTP request (OCPI peers, payments, email, push) must go through
 * `outboundFetch`. A unit test fails if any other server file calls `fetch` directly.
 */
export function isDemo(): boolean {
  const forced = process.env.DEMO_MODE?.trim().toLowerCase();
  if (forced === "true" || forced === "1") return true;
  return missingForLive().length > 0 || configErrors().length > 0;
}

export type Mode = "demo" | "live";
export const mode = (): Mode => (isDemo() ? "demo" : "live");

export class DemoModeError extends Error {
  readonly code = "demo_mode";
  constructor(action: string) {
    super(`Demo mode: refused to ${action}. Nothing was sent.`);
    this.name = "DemoModeError";
  }
}

/** Throws when demo mode is on. Call before any action with an effect outside this server. */
export function assertLive(action: string): void {
  if (isDemo()) throw new DemoModeError(action);
}

/** The only way server code may make an outbound HTTP request. Refuses in demo mode. */
export async function outboundFetch(
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(input);
  // Name the host only: paths and query strings may carry tokens.
  assertLive(`send a request to ${url.host}`);
  return fetch(url, init);
}
