import type { SIGN_IN_LIMITS, SignInLimit } from "@/lib/accounts/sign-in";

/**
 * What the sign-in answers mean for the page. The server says which limit refused a
 * request and for how long (`SignInLimit`); this turns it into words. The numbers are
 * the code's own limits, the same on every deployment.
 */
export type Limits = {
  counts: typeof SIGN_IN_LIMITS;
  /** Seconds between two codes for one address. */
  cooldown: number;
};

/** Seconds as a clock: "0:52", "38:12", "1:00:00". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const two = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

const span = (ms: number) =>
  ms === 3_600_000 ? "hour" : `${Math.round(ms / 60_000)} minutes`;

export type LimitWords = {
  title: string;
  /** Whose limit it is and why it exists. */
  whose: string;
  /** What still works while it lasts. */
  until: string;
  nextStep: string;
};

const NEWEST_CODE =
  "the newest code still works until it expires. Check the spam folder for it.";
const ASK_ONCE = "Type the newest code you have, or wait and ask once.";

/** The words for one limit: a different sentence for each source. */
export function limitWords(limit: SignInLimit, limits: Limits): LimitWords {
  const { code, verify } = limits.counts;
  if (limit.source === "email_service")
    return limit.on === "code"
      ? {
          title: "The email service is holding back sign-in emails",
          whose:
            "your email service's (Supabase Auth), not this server's. Its built-in mail sender allows only a few sign-in emails per hour for the whole project, drivers included, and one per address per minute.",
          until: NEWEST_CODE,
          nextStep:
            "Wait, then ask once. To lift the limit for good, connect your own mail provider in Supabase (Authentication, then Emails, then SMTP) and raise the email rate limit there.",
        }
      : {
          title: "The email service is refusing sign-in attempts",
          whose:
            "your email service's (Supabase Auth), not this server's. It limits how many codes may be tried in a short time.",
          until: "no code is taken, a right one included.",
          nextStep: "Wait, then type the newest code once.",
        };
  if (limit.source === "cooldown")
    return {
      title: "A code was just sent to this address",
      whose: `this server's. It sends one code per email address every ${limits.cooldown} seconds, so that a second press does not use up the email service's own limit.`,
      until: NEWEST_CODE,
      nextStep: ASK_ONCE,
    };
  if (limit.on === "code")
    return {
      email: {
        title: "Too many codes for this email",
        whose: `this server's. It sends at most ${code.perEmail.limit} codes per email address per ${span(code.perEmail.windowMs)}, so that nobody can flood an inbox.`,
        until: NEWEST_CODE,
        nextStep: ASK_ONCE,
      },
      client: {
        title: "Too many codes asked from your network",
        whose: `this server's. It takes at most ${code.perClient.limit} requests for a code per ${span(code.perClient.windowMs)} from one client address: yours, or the network you share.`,
        until: NEWEST_CODE,
        nextStep: ASK_ONCE,
      },
      total: {
        title: "This server has sent too many sign-in emails",
        whose: `this server's. It sends at most ${code.total.limit} codes per ${span(code.total.windowMs)} in total, drivers included.`,
        until: NEWEST_CODE,
        nextStep: ASK_ONCE,
      },
    }[limit.source];
  const blocked = "no code is taken, a right one included.";
  const wait = "Wait, then type the newest code once.";
  return {
    email: {
      title: "Too many tries for this email",
      whose: `this server's. It takes at most ${verify.perEmail.limit} tries per email address per ${span(verify.perEmail.windowMs)}, so that nobody can guess a code.`,
      until: blocked,
      nextStep: wait,
    },
    client: {
      title: "Too many tries from your network",
      whose: `this server's. It takes at most ${verify.perClient.limit} tries per ${span(verify.perClient.windowMs)} from one client address: yours, or the network you share.`,
      until: blocked,
      nextStep: wait,
    },
    total: {
      title: "This server has taken too many sign-in tries",
      whose: `this server's. It takes at most ${verify.total.limit} tries per ${span(verify.total.windowMs)} in total, drivers included.`,
      until: blocked,
      nextStep: wait,
    },
  }[limit.source];
}

/** The statement that adds the first admin, for the address that asked for a code. */
export function firstAdminSql(email: string): string {
  return `insert into public.emsp_admins (user_id, role)
select id, 'admin' from auth.users
where email = '${email.replaceAll("'", "''")}';`;
}
