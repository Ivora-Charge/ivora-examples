/** What a form's server action reports back. Safe to send to the browser. */
export interface ActionState {
  ok?: string;
  error?: string;
  /** An invite link to share by hand (demo mode, or no email provider). */
  link?: string;
  /** Same-origin path of that link, for the demo's "open" button. */
  path?: string;
  /** Demo mode: the email that would have been sent. */
  preview?: { to: string; subject: string; text: string };
  invite?: {
    email: string;
    role: string;
    operatorName: string;
    expiresAt: string;
    signedIn: boolean;
  };
}

export const EMPTY: ActionState = {};
