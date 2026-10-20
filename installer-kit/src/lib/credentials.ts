import { randomBytes } from "node:crypto";

// Letters and digits only: easy to type into a charger's web UI, and within
// the API's password pattern ^[a-zA-Z0-9*\-_=:+|@.]{16,40}$.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
export const PASSWORD_LENGTH = 24;
export const PASSWORD_PATTERN = /^[a-zA-Z0-9*\-_=:+|@.]{16,40}$/;

export function generatePassword(): string {
  const out: string[] = [];
  // Rejection sampling keeps every character equally likely.
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < PASSWORD_LENGTH) {
    for (const b of randomBytes(PASSWORD_LENGTH * 2)) {
      if (b < limit && out.length < PASSWORD_LENGTH)
        out.push(ALPHABET[b % ALPHABET.length]);
    }
  }
  return out.join("");
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
