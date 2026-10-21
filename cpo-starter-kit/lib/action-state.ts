/** What a form's server action reports back. Safe to send to the browser. */
export interface ActionState {
  ok?: string;
  error?: string;
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
  invite?: {
    email: string;
    role: string;
    operatorName: string;
    expiresAt: string;
    signedIn: boolean;
  };
}

export const EMPTY: ActionState = {};
