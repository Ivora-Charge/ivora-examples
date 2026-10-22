/** One row's outcome in an import check or an import. Safe to send to the browser. */
export interface ImportLine {
  /** Line in the file (1-based, the header included). */
  line: number;
  /** The card masked to its last 4 characters; null when the line could not be read. */
  masked: string | null;
  label: string | null;
  action: "create" | "update" | "unchanged" | "error";
  message: string | null;
}

export interface ImportOutcome {
  dryRun: boolean;
  counts: { create: number; update: number; unchanged: number; error: number };
  /** Every error, and every row that changes (or would change) a card. */
  lines: ImportLine[];
  /** Rows that would be sent: what an import of this file applies. */
  sendable: number;
}

/** What a Cards form's server action reports back. Never a full card value. */
export interface CardsState {
  ok?: string;
  error?: string;
  /** Every problem with a form, after the first (in `error`). */
  problems?: string[];
  warnings?: string[];
  /** The page of a card just added. */
  cardPath?: string;
  /** Import: what the check found, or what the import did. */
  outcome?: ImportOutcome;
  /** Import: the checked file, sent again by "Import". */
  csv?: string;
  /** A new request ID for the next submit, after one that finished. */
  requestId?: string;
}

export const NO_STATE: CardsState = {};
