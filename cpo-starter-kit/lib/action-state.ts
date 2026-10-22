/** What a form's server action reports back. Safe to send to the browser. */
export interface ActionState {
  ok?: string;
  error?: string;
  /**
   * Driver checkout: the kind of error (for example `offline`), and Ivora's error code
   * and request ID when Ivora answered, for support. Never keys or personal data.
   */
  errorDetail?: { kind: string; apiCode?: string; requestId?: string };
  /** Saved, but something after it needs attention (for example an Ivora push). */
  warning?: string;
  /** An invite link to share by hand (demo mode, or no email provider). */
  link?: string;
  /** Same-origin path of that link, for the demo's "open" button. */
  path?: string;
  /** Demo mode: the email that would have been sent. */
  preview?: { to: string; subject: string; text: string };
  /**
   * A new charger password with what the charger needs to connect. Shown once, in the
   * response to the action that set it; never stored or logged.
   */
  secret?: { password: string; connectionUrl: string; username: string };
  /** Every problem with a form, after the first (in `error`). */
  problems?: string[];
  /** A tariff preview (Pricing). */
  quote?: QuotePreview;
  invite?: {
    email: string;
    role: string;
    operatorName: string;
    expiresAt: string;
    signedIn: boolean;
  };
}

export const EMPTY: ActionState = {};

/**
 * A tariff preview: Ivora's simulated amounts for one session, formatted on the server
 * exactly as Ivora returned them. The browser only shows it.
 */
export interface QuotePreview {
  /** "A 30 kWh session on Tue, Oct 20, 2026 from 18:00 to 20:30 … costs $13.50." */
  sentence: string;
  lines: {
    label: string;
    quantity: string;
    unitPrice: string;
    amount: string;
  }[];
  adjustments: { label: string; amount: string }[];
  subtotal: string;
  total: string;
  totalMinor: number;
  currency: string;
  driverText: string;
  notes: string[];
  /** Things to act on, for example a session that costs more than the card hold. */
  warnings: string[];
  demo: boolean;
}
