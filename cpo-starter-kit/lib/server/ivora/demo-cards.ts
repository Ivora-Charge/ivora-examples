import "server-only";
import { z } from "zod";
import { IvoraError } from "./errors";
import type {
  TokenImportResult,
  TokenImportRow,
  TokenRecord,
  TokenUpdate,
} from "./types";

// The demo stand-in for Ivora's token list (the Cards module). Five sample RFID cards,
// plus the visitor's own changes and up to DEMO_MAX_CARDS cards of their own, kept in
// a store (an HTTP-only cookie in the app). It checks values the way the API documents
// and never sends anything anywhere. Every value starts with DEMO, so none can be
// mistaken for a real card.

/** Cards a visitor can add in the demo (they live in a cookie). */
export const DEMO_MAX_CARDS = 8;

const CREATED = "2025-01-06T09:00:00.000Z";

/** The sample cards. Sample RFID sessions in demo history use the first four. */
export const SAMPLE_CARDS: readonly TokenRecord[] = [
  {
    id: 9601,
    id_token: "DEMO-RFID-0001",
    type: "ISO14443",
    status: "Accepted",
    expires_at: null,
    label: "Driver: Sample Driver Ada",
    external_reference: null,
    ocpp16_compatible: true,
    created_at: CREATED,
    updated_at: CREATED,
  },
  {
    id: 9602,
    id_token: "DEMO-RFID-0002",
    type: "ISO14443",
    status: "Accepted",
    expires_at: null,
    label: "Driver: Sample Driver Ben",
    external_reference: null,
    ocpp16_compatible: true,
    created_at: CREATED,
    updated_at: CREATED,
  },
  {
    id: 9603,
    id_token: "DEMO-RFID-0003",
    type: "ISO14443",
    status: "Accepted",
    expires_at: null,
    label: "Vehicle: Sample Van 1",
    external_reference: null,
    ocpp16_compatible: true,
    created_at: CREATED,
    updated_at: CREATED,
  },
  {
    id: 9604,
    id_token: "DEMO-RFID-0004",
    type: "ISO14443",
    status: "Accepted",
    expires_at: "2027-07-01T05:00:00.000Z",
    label: "Vehicle: Sample Van 2",
    external_reference: null,
    ocpp16_compatible: true,
    created_at: CREATED,
    updated_at: CREATED,
  },
  {
    id: 9605,
    id_token: "DEMO-RFID-0005",
    type: "ISO14443",
    status: "Blocked",
    expires_at: null,
    label: "Driver: Sample Driver Cleo",
    external_reference: null,
    ocpp16_compatible: true,
    created_at: CREATED,
    updated_at: CREATED,
  },
];

/** Sample card values that demo history's RFID sessions charged with. */
export const SAMPLE_SESSION_CARDS = SAMPLE_CARDS.slice(0, 4).map(
  (c) => c.id_token,
);

const STATUS = z.enum(["Accepted", "Blocked", "Expired"]);
const time = z.string().max(40).nullable();
const label = z.string().min(1).max(80).nullable();

// Short keys: the whole state has to fit in one cookie.
const stateSchema = z.object({
  /** The visitor's own cards. */
  added: z
    .array(
      z.object({
        i: z.number().int().positive(),
        v: z.string().max(36),
        l: label,
        s: STATUS,
        e: time,
        r: z.string().max(128).nullable(),
        c: z.string().max(40),
        u: z.string().max(40),
      }),
    )
    .max(DEMO_MAX_CARDS),
  /** Changes to sample cards, by ID. */
  changed: z.record(
    z.string().regex(/^\d+$/),
    z.object({ l: label, s: STATUS, e: time, u: z.string().max(40) }),
  ),
});

export type DemoCardsState = z.infer<typeof stateSchema>;

export interface DemoCardsStore {
  load(): Promise<DemoCardsState>;
  save(s: DemoCardsState): Promise<void>;
}

export const emptyDemoCards = (): DemoCardsState => ({
  added: [],
  changed: {},
});

export function decodeDemoCards(raw: string | undefined): DemoCardsState {
  if (!raw) return emptyDemoCards();
  try {
    const parsed = stateSchema.safeParse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : emptyDemoCards();
  } catch {
    return emptyDemoCards();
  }
}

export const encodeDemoCards = (s: DemoCardsState) =>
  Buffer.from(JSON.stringify(s), "utf8").toString("base64url");

/** Outside a request (tests): the state lives in memory. */
export function memoryDemoCards(): DemoCardsStore & { state: DemoCardsState } {
  return {
    state: emptyDemoCards(),
    async load() {
      return structuredClone(this.state);
    },
    async save(s) {
      this.state = structuredClone(s);
    },
  };
}

/** Every card in the demo's token list: the samples as changed, then the visitor's. */
export function demoCards(s: DemoCardsState): TokenRecord[] {
  const samples = SAMPLE_CARDS.map((c) => {
    const ch = s.changed[String(c.id)];
    return ch
      ? { ...c, label: ch.l, status: ch.s, expires_at: ch.e, updated_at: ch.u }
      : { ...c };
  });
  return [
    ...samples,
    ...s.added.map((a): TokenRecord => ({
      id: a.i,
      id_token: a.v,
      type: "ISO14443",
      status: a.s,
      expires_at: a.e,
      label: a.l,
      external_reference: a.r,
      ocpp16_compatible: a.v.length <= 20,
      created_at: a.c,
      updated_at: a.u,
    })),
  ];
}

/** The API's value rules: 1 to 36 printable ASCII characters, no spaces. */
const VALUE = /^[\x21-\x7e]{1,36}$/;
/** Values Ivora keeps for payment flow charging tokens (token_reserved). */
const RESERVED = [/^iv[0-9a-f]{18}$/i, /^remotestart-\d+$/i, /^PAY_\d+$/i];

function valueProblem(v: string): IvoraError | null {
  if (!VALUE.test(v))
    return new IvoraError(
      422,
      "invalid_request",
      "id_token must be 1-36 printable ASCII characters without spaces",
    );
  if (RESERVED.some((r) => r.test(v)))
    return new IvoraError(
      422,
      "token_reserved",
      "This value is reserved for payment flow charging tokens",
    );
  return null;
}

const iso = (ms: number) => new Date(ms).toISOString();

function nextId(s: DemoCardsState) {
  return Math.max(9650, ...s.added.map((a) => a.i)) + 1;
}

/**
 * `POST /tokens` for a card. `taken` holds the values of tokens kept elsewhere (the
 * staff and free charging tokens): a value is unique per project, whatever its case.
 */
export function demoCreateCard(
  s: DemoCardsState,
  input: { id_token: string; label: string; external_reference: string },
  taken: string[],
  now: number,
): TokenRecord {
  const bad = valueProblem(input.id_token);
  if (bad) throw bad;
  const same = (v: string) => v.toUpperCase() === input.id_token.toUpperCase();
  const existing = demoCards(s).find((c) => same(c.id_token));
  if (existing)
    throw new IvoraError(
      409,
      "token_exists",
      "A token with this value is already registered",
      undefined,
      undefined,
      { token_id: existing.id },
    );
  if (taken.some(same))
    throw new IvoraError(
      409,
      "token_exists",
      "A token with this value is already registered",
    );
  if (s.added.length >= DEMO_MAX_CARDS)
    throw new IvoraError(
      409,
      "demo_limit",
      `The demo keeps at most ${DEMO_MAX_CARDS} cards of your own; reset the demo cards to add more`,
    );
  const t = iso(now);
  s.added.push({
    i: nextId(s),
    v: input.id_token,
    l: input.label,
    s: "Accepted",
    e: null,
    r: input.external_reference,
    c: t,
    u: t,
  });
  return demoCards(s).at(-1)!;
}

/** `PATCH /tokens/{id}`: changes only the fields sent. */
export function demoUpdateCard(
  s: DemoCardsState,
  id: number,
  input: TokenUpdate,
  now: number,
): TokenRecord {
  const card = demoCards(s).find((c) => c.id === id);
  if (!card) throw new IvoraError(404, "token_not_found", "Unknown token");
  const next = {
    l: input.label !== undefined ? input.label : (card.label ?? null),
    s: (input.status ?? card.status) as z.infer<typeof STATUS>,
    e: input.expires_at !== undefined ? input.expires_at : card.expires_at!,
    u: iso(now),
  };
  const added = s.added.find((a) => a.i === id);
  if (added) Object.assign(added, next);
  else s.changed[String(id)] = next;
  return demoCards(s).find((c) => c.id === id)!;
}

/**
 * `POST /tokens/import` on the demo's list, with the API's row rules: a row matches
 * an existing card by value (case-insensitive), a new value is created (Accepted), an
 * existing one gets the row's label, and invalid rows are reported and skipped. A dry
 * run changes nothing.
 */
export function demoImportCards(
  s: DemoCardsState,
  rows: TokenImportRow[],
  dryRun: boolean,
  now: number,
): TokenImportResult {
  const result: TokenImportResult = {
    dry_run: dryRun,
    counts: { create: 0, update: 0, unchanged: 0, error: 0 },
    rows: [],
  };
  const work = structuredClone(s);
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const row = i + 1;
    const fail = (code: string, message: string) => {
      result.counts.error++;
      result.rows.push({
        row,
        id_token: r.id_token,
        action: "error",
        code,
        message,
      });
    };
    const bad = valueProblem(r.id_token);
    if (bad)
      return fail(
        bad.code === "token_reserved" ? bad.code : "invalid",
        bad.message,
      );
    const key = r.id_token.toUpperCase();
    if (seen.has(key))
      return fail("duplicate_in_file", "This value is in the file twice");
    seen.add(key);
    const existing = demoCards(work).find(
      (c) => c.id_token.toUpperCase() === key,
    );
    if (existing) {
      if (existing.label === r.label) {
        result.counts.unchanged++;
        return;
      }
      demoUpdateCard(work, existing.id, { label: r.label }, now);
      result.counts.update++;
      result.rows.push({
        row,
        id_token: r.id_token,
        action: "update",
        token_id: existing.id,
      });
      return;
    }
    if (work.added.length >= DEMO_MAX_CARDS)
      return fail(
        "demo_limit",
        `The demo keeps at most ${DEMO_MAX_CARDS} cards of your own`,
      );
    const t = iso(now);
    const id = nextId(work);
    work.added.push({
      i: id,
      v: r.id_token,
      l: r.label,
      s: "Accepted",
      e: null,
      r: null,
      c: t,
      u: t,
    });
    result.counts.create++;
    result.rows.push({
      row,
      id_token: r.id_token,
      action: "create",
      token_id: id,
    });
  });
  if (!dryRun) Object.assign(s, work);
  return result;
}
