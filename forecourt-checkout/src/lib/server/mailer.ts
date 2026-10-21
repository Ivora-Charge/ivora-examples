import "server-only";
import type { ReceiptEmail } from "../receipt-email";
import { UserError } from "./sessions";

// Emailed receipts go through one small interface, so any provider fits.
// ResendMailer is the example. The address is used for this one send and
// never stored or logged. Demo mode has no mailer at all (see
// receiptMailer() in services.ts), so it cannot send.

export interface ReceiptMailer {
  /** `idempotencyKey` is one per cashier tap, so a retry never sends twice. */
  send(
    email: ReceiptEmail,
    idempotencyKey: string,
  ): Promise<{ id: string | null }>;
}

export class MailerError extends Error {
  readonly name = "MailerError";
  constructor(public status: number) {
    super(`The email provider refused the request (${status}).`);
  }
}

/** https://resend.com/docs/api-reference/emails/send-email */
export class ResendMailer implements ReceiptMailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async send(email: ReceiptEmail, idempotencyKey: string) {
    const response = await this.fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        from: this.from,
        to: [email.to],
        subject: email.subject,
        text: email.text,
        html: email.html,
      }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new MailerError(response.status);
    const body = (await response.json().catch(() => null)) as {
      id?: unknown;
    } | null;
    return { id: typeof body?.id === "string" ? body.id : null };
  }
}

export type EmailResult = {
  sent: boolean;
  demo: boolean;
  /** Demo mode: the email that would have been sent. */
  preview: { to: string; subject: string; text: string } | null;
};

/** The one place a receipt is handed to a provider. Demo mode returns a preview instead. */
export async function deliverReceipt(
  email: ReceiptEmail,
  idempotencyKey: string,
  options: {
    demo: boolean;
    mailer: ReceiptMailer | null;
    sale: string;
  },
): Promise<EmailResult> {
  if (options.demo)
    return {
      sent: false,
      demo: true,
      preview: { to: email.to, subject: email.subject, text: email.text },
    };
  if (!options.mailer)
    throw new UserError(404, "email_off", "Emailed receipts are off.");
  try {
    const { id } = await options.mailer.send(email, idempotencyKey);
    console.info("[forecourt] receipt emailed", {
      sale: options.sale,
      message: id,
    });
  } catch (error) {
    console.warn("[forecourt] receipt email failed", {
      sale: options.sale,
      status: error instanceof MailerError ? error.status : null,
    });
    throw new UserError(
      502,
      "email_failed",
      "The email provider could not send the receipt. Try again, or print it.",
    );
  }
  return { sent: true, demo: false, preview: null };
}
