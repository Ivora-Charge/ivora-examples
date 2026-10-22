import "server-only";

export type FleetErrorCode =
  | "invalid"
  | "stale"
  | "exists"
  | "not_found"
  | "kit_token"
  | "uncertain"
  | "off";

/** A problem staff can act on, with what to do next. */
export class FleetError extends Error {
  constructor(
    public code: FleetErrorCode,
    message: string,
    /** Every problem with the form, after the first (in message). */
    public problems: string[] = [],
  ) {
    super(message);
    this.name = "FleetError";
  }
}

export type HolderKind = "driver" | "vehicle";

/** Who a card is for, from its Ivora label ("Driver: …" or "Vehicle: …"). */
export interface Holder {
  /** Null when the label was set elsewhere, not in the kit's form. */
  kind: HolderKind | null;
  name: string;
}

/** What a charger does with the card now. */
export type CardState = "active" | "blocked" | "expired" | "other";

/** One RFID card in Ivora's token list. The full value never leaves the server. */
export interface Card {
  /** Ivora's token ID. */
  id: number;
  /** As the API shows it in sessions: ****1234. */
  masked: string;
  /** Its last 4 characters, upper-cased: what its sessions are matched by. */
  key: string;
  holder: Holder;
  /** Ivora's own status: Accepted, Blocked, Expired (or another OCPP status). */
  status: string;
  state: CardState;
  expiresAt: string | null;
  /** False when the value is longer than an OCPP 1.6 idTag (20 characters). */
  ocpp16: boolean;
  /** Ivora's updated_at: forms name it, and a change over a newer one is refused. */
  revision: string;
  /** Added from this kit (external_reference cpo-card-…). */
  kit: boolean;
}

/** A card's sessions and energy in the period. */
export interface CardUsage {
  sessions: number;
  running: number;
  energyWh: number;
}

/** Sessions per token key (the token's last 4 characters). */
export interface KeyUsage extends CardUsage {
  key: string;
}

/** A session as the card ledger keeps it. */
export interface LedgerSession {
  transactionId: number;
  stationId: number;
  connectorNumber: number | null;
  /** The token's last 4 characters, upper-cased. */
  key: string;
  startedAt: string | null;
  endedAt: string | null;
  energyWh: number | null;
  active: boolean;
}

/**
 * Each card's sessions: the kit's ledger of Ivora sessions by token key. The Supabase
 * ledger is filled by a scan of each station's transactions (see usage.ts); the demo
 * ledger reads the sample history and changes nothing.
 */
export interface CardLedger {
  readonly mode: "live" | "demo";
  /** Sessions started in [since, until), per key, without the kit's own checkouts. */
  usage(since: number, until: number): Promise<KeyUsage[]>;
  /** One key's sessions in [since, until), newest first. */
  sessions(
    key: string,
    since: number,
    until: number,
    limit: number,
  ): Promise<LedgerSession[]>;
  getTransactionMark(stationId: number): Promise<number | null>;
  /** Moves the mark up (never down); `scanned` stamps a scan that reached the end. */
  advanceTransactionMark(
    stationId: number,
    transactionId: number,
    scanned?: boolean,
  ): Promise<void>;
  /** When each station's list was last scanned to its end (ms). */
  scannedAt(): Promise<Map<number, number>>;
  record(s: LedgerSession): Promise<void>;
  /** Ivora no longer knows the session (404). */
  forget(transactionId: number): Promise<void>;
  /** Running sessions last read before `before` (ms), oldest check first. */
  due(
    before: number,
    limit: number,
  ): Promise<{ transactionId: number; stationId: number }[]>;
}

export interface CardRow extends Card {
  /** Null when another token shares the key: its sessions can't be told apart. */
  usage: CardUsage | null;
  /** Other tokens in the list with the same last 4 characters. */
  sharedWith: number;
}

export interface CardsView {
  demo: boolean;
  cards: CardRow[];
  /** Cards in the list before filters. */
  total: number;
  /** More tokens than the kit reads (MAX_LIST_PAGES pages of 100). */
  truncated: boolean;
  days: number;
  zone: string;
  /** The ledger could not be read: figures are missing, with this message. */
  usageError: string | null;
  /** Chargers marked private in Pricing: no QR checkout, cards and staff only. */
  privateChargers: { id: number; name: string }[];
}

export interface CardSessionRow extends LedgerSession {
  stationName: string | null;
}

export interface CardDetail {
  demo: boolean;
  card: Card;
  usage: CardUsage | null;
  /** Other cards in the list with the same last 4 characters. */
  sharedWith: Card[];
  /** Other tokens (the kit's own, or set up elsewhere) with the same last 4. */
  sharedOther: number;
  sessions: CardSessionRow[];
  days: number;
  zone: string;
  usageError: string | null;
}

export type { ImportLine, ImportOutcome } from "@/lib/cards-state";
