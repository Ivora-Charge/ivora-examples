import "server-only";
import { randomBytes } from "node:crypto";

// Copied from installer-kit (templates do not share code).
// Letters and digits only: easy to type into a charger's web UI, and within the API's
// password pattern ^[a-zA-Z0-9*\-_=:+|@.]{16,40}$.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
export const PASSWORD_LENGTH = 24;
export const PASSWORD_PATTERN = /^[a-zA-Z0-9*\-_=:+|@.]{16,40}$/;

/** A random charger password. Shown once to the person who set it, never stored. */
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
