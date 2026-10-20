// Payment terminals are planned, not built. This is the adapter a card
// terminal on the charger (or on the forecourt) would implement so the same
// session flow can run from a card tap instead of a phone. Nothing in the app
// calls it yet.
//
// Planned flow: the driver taps a card on the terminal; the adapter places a
// hold and reports it; the app creates the Ivora externally funded session with
// the terminal's payment reference, starts charging, and later captures the
// final amount (with the deployer's application fee) or releases the hold,
// exactly as the phone checkout does today.

import type { Hold } from "./payments";

export type TerminalHoldRequest = {
  /** The app's session reference, also sent to Ivora as application_reference. */
  reference: string;
  terminalId: string;
  holdCents: number;
  currency: string;
  idempotencyKey: string;
};

export interface CardTerminalAdapter {
  readonly processor: string;
  /** Show the hold amount and wait for a card tap; resolves once authorized or declined. */
  presentHold(request: TerminalHoldRequest): Promise<Hold>;
  capture(
    holdId: string,
    amountCents: number,
    applicationFeeCents: number,
    idempotencyKey: string,
  ): Promise<Hold>;
  release(holdId: string, idempotencyKey: string): Promise<Hold>;
  /** Print or display the receipt on the terminal, if it has a printer or screen. */
  showReceipt(holdId: string, lines: string[]): Promise<void>;
}

export class TerminalNotAvailableError extends Error {
  readonly name = "TerminalNotAvailableError";
  constructor() {
    super(
      "Card terminals are planned but not implemented in this template. Drivers pay by phone.",
    );
  }
}

/** Placeholder that fails loudly, so a half-wired terminal never takes money. */
export class PlannedTerminalAdapter implements CardTerminalAdapter {
  readonly processor = "terminal";
  presentHold(): Promise<Hold> {
    return Promise.reject(new TerminalNotAvailableError());
  }
  capture(): Promise<Hold> {
    return Promise.reject(new TerminalNotAvailableError());
  }
  release(): Promise<Hold> {
    return Promise.reject(new TerminalNotAvailableError());
  }
  showReceipt(): Promise<void> {
    return Promise.reject(new TerminalNotAvailableError());
  }
}
