import { randomBytes } from "node:crypto";

// 32 characters without 0/O and 1/I, so codes read back correctly off a sticker.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const STICKER_CODE_LENGTH = 8;

/** A random sticker code you control; it never encodes a station or Ivora ID. */
export function newStickerCode(): string {
  // 256 is a multiple of 32, so the modulo has no bias.
  return Array.from(
    randomBytes(STICKER_CODE_LENGTH),
    (b) => ALPHABET[b % ALPHABET.length],
  ).join("");
}

export function isStickerCode(value: string): boolean {
  return new RegExp(`^[${ALPHABET}]{${STICKER_CODE_LENGTH}}$`).test(value);
}
