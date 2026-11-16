import "server-only";

// Invite and sign-in emails go through one small interface, so any provider fits.
// ResendMailer is the example. Addresses are used for the send only and never
// logged. Demo mode has no mailer at all (see getTeam()), so it cannot send.

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  /** One key per logical email, so a retry never sends it twice. */
  send(email: Email, idempotencyKey: string): Promise<void>;
}

export class MailerError extends Error {
  readonly name = "MailerError";
  constructor(public status: number) {
    super(`The email provider refused the request (${status}).`);
  }
}

/** https://resend.com/docs/api-reference/emails/send-email */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetcher: typeof fetch = (...a) => fetch(...a),
  ) {}

  async send(email: Email, idempotencyKey: string) {
    let response: Response;
    try {
      response = await this.fetcher("https://api.resend.com/emails", {
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
    } catch {
      throw new MailerError(0);
    }
    if (!response.ok) throw new MailerError(response.status);
  }
}

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

function linkEmail(
  to: string,
  subject: string,
  lines: string[],
  action: string,
  link: string,
  footer: string,
): Email {
  return {
    to,
    subject,
    text: [...lines, "", `${action}: ${link}`, "", footer].join("\n"),
    html: [
      ...lines.map((l) => `<p>${escape(l)}</p>`),
      `<p><a href="${escape(link)}">${escape(action)}</a></p>`,
      `<p style="color:#555">${escape(footer)}</p>`,
    ].join("\n"),
  };
}

export function inviteEmail(o: {
  to: string;
  operatorName: string;
  roleLabel: string;
  link: string;
  expiresHours: number;
}): Email {
  return linkEmail(
    o.to,
    `You're invited to join ${o.operatorName}`,
    [
      `You have been invited to join ${o.operatorName} as ${o.roleLabel}.`,
      `The link works once and expires in ${o.expiresHours} hours.`,
    ],
    "Accept the invite",
    o.link,
    "If you were not expecting this, ignore this email.",
  );
}

export function signInEmail(o: {
  to: string;
  operatorName: string;
  link: string;
}): Email {
  return linkEmail(
    o.to,
    `Sign in to ${o.operatorName}`,
    [
      `Use this link to sign in to ${o.operatorName}.`,
      "It works once and expires soon.",
    ],
    "Sign in",
    o.link,
    "If you did not ask to sign in, ignore this email.",
  );
}

/** A new fault at one of a host's sites, for the host's users (the host's switch). */
export function faultEmail(o: {
  to: string;
  hostName: string;
  stationName: string;
  fault: string;
  link: string;
}): Email {
  return linkEmail(
    o.to,
    `Fault on ${o.stationName}`,
    [
      `${o.stationName}, at a site of ${o.hostName}, reported a fault: ${o.fault}.`,
      "Live shows its status and fault history.",
    ],
    "Open Live",
    o.link,
    "You get this because the operator switched on fault emails for your host.",
  );
}
