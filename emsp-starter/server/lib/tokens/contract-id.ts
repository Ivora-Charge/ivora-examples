import "server-only";
import { randomBytes, randomInt } from "node:crypto";
import type { Party } from "@/lib/ocpi/types";

/**
 * Contract IDs in eMA ID format (ISO 15118 / eMI3): our country code, our party ID, the
 * ID type `C` and an 8-character instance, without separators and without the optional
 * check digit, like the 2.2.1 examples (`NL8ACC12E46L89`). Every token of a driver
 * carries the driver's contract ID.
 */
const INSTANCE_ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O
export const CONTRACT_ID = /^[A-Z]{2}[A-Z0-9]{3}C[A-Z0-9]{8}$/;

export function newContractId(party: Party): string {
  let instance = "";
  for (let i = 0; i < 8; i++)
    instance += INSTANCE_ALPHABET[randomInt(INSTANCE_ALPHABET.length)];
  return `${party.countryCode}${party.partyId}C${instance}`.toUpperCase();
}

/** A new APP_USER token uid: 80 random bits, upper-case hex. */
export function newAppUserUid(): string {
  return randomBytes(10).toString("hex").toUpperCase();
}

/**
 * An RFID card's uid as we store it: upper case, with spaces, colons and hyphens
 * removed (`04:a1:b2:c3` becomes `04A1B2C3`). Undefined when it is not 4 to 36 letters
 * and digits.
 */
export function normalizeRfidUid(input: string): string | undefined {
  const uid = input.replace(/[\s:-]+/g, "").toUpperCase();
  return /^[A-Z0-9]{4,36}$/.test(uid) ? uid : undefined;
}
