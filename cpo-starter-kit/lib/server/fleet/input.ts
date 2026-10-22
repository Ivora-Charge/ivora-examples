import "server-only";
import { randomBytes } from "node:crypto";
import type { Holder, HolderKind } from "./types";

// Card values, holder labels and the import file. The CSV reader follows
// fleet-depot's (quoted cells, `,` or `;`, an optional header), with a holder column
// so a card is labelled per driver or vehicle.

/** The API's rule for a token value: 1 to 36 printable ASCII characters, no spaces. */
export const CARD_VALUE = /^[\x21-\x7e]{1,36}$/;
/** An OCPP 1.6 idTag is at most 20 characters. */
export const OCPP16_MAX = 20;
/** Values Ivora keeps for payment flow charging tokens (it answers token_reserved). */
const RESERVED = [/^iv[0-9a-f]{18}$/i, /^remotestart-\d+$/i, /^PAY_\d+$/i];

/** The longest holder name: "Vehicle: " plus this fits Ivora's 80-character label. */
export const NAME_MAX = 70;
/** Rows per import file (Ivora takes up to 5,000; a small operator needs far fewer). */
export const IMPORT_MAX_ROWS = 1000;
/** Bytes per import file. */
export const IMPORT_MAX_BYTES = 256 * 1024;

export const HOLDER_LABELS: Record<HolderKind, string> = {
  driver: "Driver",
  vehicle: "Vehicle",
};

/** A problem with a card value, or null when Ivora would take it. */
export function cardValueProblem(value: string): string | null {
  if (!value) return "Enter the card's value (the ID its reader shows).";
  if (!CARD_VALUE.test(value))
    return "A card value is 1 to 36 letters, digits or symbols, without spaces.";
  if (RESERVED.some((r) => r.test(value)))
    return "Ivora keeps this kind of value for payment tokens; it can't be a card.";
  return null;
}

/** The card's last 4 characters, upper-cased: chargers match cards case-insensitively. */
export const cardKey = (value: string) => value.slice(-4).toUpperCase();

/** Masked like the API's sessions: ****1234. */
export const maskCard = (value: string) => `****${value.slice(-4)}`;

/**
 * The key of a session's token as the API shows it (****1234), or null when there is
 * none. The API masks a token to its last 4 characters behind ****.
 */
export function maskedKey(masked: string | null | undefined): string | null {
  if (!masked) return null;
  const tail = (masked.startsWith("****") ? masked.slice(4) : masked).slice(-4);
  return tail && /^[\x21-\x7e]+$/.test(tail) ? tail.toUpperCase() : null;
}

/** A holder name: trimmed, spaces collapsed, no control characters. */
export function holderName(
  raw: string,
): { name: string } | { problem: string } {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) return { problem: "Enter the driver's or vehicle's name." };
  if (name.length > NAME_MAX)
    return { problem: `A name is at most ${NAME_MAX} characters.` };
  if (/[\x00-\x1f\x7f]/.test(name))
    return { problem: "A name can't contain control characters." };
  return { name };
}

/** Ivora's label for a card: "Driver: Sam Sample" or "Vehicle: Van 12". */
export const formatLabel = (kind: HolderKind, name: string) =>
  `${HOLDER_LABELS[kind]}: ${name}`;

/** Who the card is for, from its label. A label set elsewhere is shown as it is. */
export function parseLabel(label: string | null | undefined): Holder {
  const m = /^(Driver|Vehicle): (.+)$/.exec(label ?? "");
  if (m) return { kind: m[1] === "Driver" ? "driver" : "vehicle", name: m[2] };
  return { kind: null, name: label ?? "" };
}

export function holderKind(raw: string | undefined): HolderKind | null {
  const v = raw?.trim().toLowerCase();
  return v === "driver" || v === "vehicle" ? v : null;
}

function splitLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') ((cur += '"'), i++);
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === "," || c === ";") (cells.push(cur.trim()), (cur = ""));
    else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

export interface CsvCard {
  /** Line in the file, 1-based. */
  line: number;
  value: string;
  kind: HolderKind;
  name: string;
}

export interface CsvResult {
  rows: CsvCard[];
  errors: { line: number; message: string }[];
}

const HEADER = /^(card|card_?value|id_?tag|id_?token|rfid|tag|uid)$/i;

/**
 * Reads "card,holder,name" lines, holder being driver or vehicle. A header line is
 * detected and skipped; blank lines are ignored. A value that is in the file twice
 * (in any case) is refused on its later line.
 */
export function parseCardsCsv(text: string): CsvResult {
  const rows: CsvCard[] = [];
  const errors: { line: number; message: string }[] = [];
  const seen = new Map<string, number>();
  let first = true;
  text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .forEach((raw, idx) => {
      const line = idx + 1;
      if (!raw.trim()) return;
      const cells = splitLine(raw);
      if (first) {
        first = false;
        if (HEADER.test(cells[0])) return;
      }
      const fail = (message: string) => void errors.push({ line, message });
      if (cells.length !== 3)
        return fail(
          "Each line needs 3 columns: card, holder (driver or vehicle), name.",
        );
      const [value, holder, rawName] = cells;
      const bad = cardValueProblem(value);
      if (bad) return fail(bad);
      const kind = holderKind(holder);
      if (!kind) return fail('The holder must be "driver" or "vehicle".');
      const n = holderName(rawName);
      if ("problem" in n) return fail(n.problem);
      const key = value.toUpperCase();
      const before = seen.get(key);
      if (before !== undefined)
        return fail(`This card is already on line ${before}.`);
      seen.set(key, line);
      rows.push({ line, value, kind, name: n.name });
    });
  return { rows, errors };
}

/** YYYY-MM-DD that is a real date. */
export function validDate(v: string | null | undefined): v is string {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** A form's request ID: random, made when the form was shown. */
export const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/;

/** What the card page's forms change. */
export const CARD_INTENTS = [
  "label",
  "block",
  "unblock",
  "expire",
  "expiry",
  "clear-expiry",
] as const;
export type CardIntent = (typeof CARD_INTENTS)[number];

export const isCardIntent = (v: unknown): v is CardIntent =>
  typeof v === "string" && (CARD_INTENTS as readonly string[]).includes(v);

/** A new random request ID for a form (the Idempotency-Key of what it sends). */
export const newRequestId = () => randomBytes(16).toString("base64url");
