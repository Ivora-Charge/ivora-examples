import "server-only";
import { config } from "@/lib/server/config";
import { isDemo, outboundFetch } from "@/lib/server/demo";

/**
 * One interface for sending email receipts, so any provider fits: implement `Mailer`
 * and return it from `mailer()`. Resend is the example. Demo mode gets `DemoOutbox`,
 * which keeps the emails in memory and sends nothing.
 */
export type Email = {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** The same key never sends twice, where the provider supports it. */
  idempotencyKey: string;
};

export interface Mailer {
  readonly name: string;
  send(email: Email): Promise<void>;
}

/** Resend (https://resend.com), over its REST API through `outboundFetch`. */
export class ResendMailer implements Mailer {
  readonly name = "resend";
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly transport: typeof outboundFetch = outboundFetch,
  ) {}

  async send(email: Email) {
    const res = await this.transport("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": email.idempotencyKey,
      },
      body: JSON.stringify({
        from: this.from,
        to: [email.to],
        subject: email.subject,
        text: email.text,
        html: email.html,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel();
    // Status only: the answer may repeat the address.
    if (!res.ok) throw new Error(`Email provider answered HTTP ${res.status}`);
  }
}

/** Demo mode's mailer: keeps the last emails in memory, labelled, and sends nothing. */
export class DemoOutbox implements Mailer {
  readonly name = "demo";
  readonly sent: Email[] = [];
  async send(email: Email) {
    this.sent.push(email);
    if (this.sent.length > 50) this.sent.shift();
  }
}

const holder = globalThis as unknown as {
  __emspDemoOutbox?: DemoOutbox;
  __emspMailerOverride?: Mailer | null;
};

/** Demo mode's outbox. */
export const demoOutbox = () => (holder.__emspDemoOutbox ??= new DemoOutbox());

/**
 * The mailer in use: the demo outbox in demo mode; Resend in live mode with
 * RESEND_API_KEY and RECEIPT_FROM; else null (no receipts).
 */
export function mailer(): Mailer | null {
  if (isDemo()) return demoOutbox();
  if (holder.__emspMailerOverride !== undefined)
    return holder.__emspMailerOverride;
  const key = config.resendApiKey;
  const from = config.receiptFrom;
  return key && from ? new ResendMailer(key, from) : null;
}

/** Tests only: the mailer live mode uses; undefined goes back to the default. */
export function setMailerForTests(m: Mailer | null | undefined) {
  holder.__emspMailerOverride = m;
}
