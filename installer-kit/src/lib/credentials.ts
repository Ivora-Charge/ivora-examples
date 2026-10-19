import { randomBytes } from "node:crypto";

export function generatePassword(): string {
  return randomBytes(12).toString("base64url");
}

/** Show only the length-preserving shape of a secret, never its content. */
export function maskSecret(secret: string): string {
  return "•".repeat(Math.max(secret.length, 8));
}

export type Credentials = { stationId: string; password: string };

/** The plain password is shown once, at creation. Afterwards only a mask. */
export function firstDisplay(c: Credentials) {
  return {
    stationId: c.stationId,
    password: c.password,
    masked: maskSecret(c.password),
  };
}

export function afterFirstDisplay(c: Credentials) {
  return {
    stationId: c.stationId,
    password: null,
    masked: maskSecret(c.password),
  };
}
