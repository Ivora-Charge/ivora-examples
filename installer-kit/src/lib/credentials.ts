import { randomBytes } from "node:crypto";

// 20 random bytes, hex-encoded: 40 characters (160 bits). One format that is
// valid on every path, so the kit never has to predict which one applies:
// - stored for the charger's first connection: the API's pattern
//   ^[a-zA-Z0-9*\-_=:+|@.]{16,40}$;
// - pushed live to a connected OCPP 1.6 charger: even-length hex, 32-40
//   characters.
// Hex is also easy to type into a charger's web UI (0-9 and a-f only).
export const PASSWORD_BYTES = 20;
export const PASSWORD_PATTERN = /^[a-zA-Z0-9*\-_=:+|@.]{16,40}$/;
/** What a live push to an OCPP 1.6 charger accepts. */
export const LIVE_PUSH_PATTERN = /^(?:[0-9a-fA-F]{2}){16,20}$/;

export function generatePassword(): string {
  return randomBytes(PASSWORD_BYTES).toString("hex");
}

/** A fixed-width mask: reveals neither the content nor the length. */
export function maskSecret(_secret: string): string {
  return "•".repeat(12);
}

/**
 * The plain password leaves the server exactly once, in the response that
 * created it. Everything stored or returned later carries only the mask.
 */
export function firstDisplay(password: string) {
  return { password, masked: maskSecret(password) };
}

export function afterFirstDisplay(password: string) {
  return { password: null, masked: maskSecret(password) };
}
