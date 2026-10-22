import "server-only";
import { SyncError } from "@/lib/locations/sync";
import {
  OcpiError,
  OcpiNotSentError,
  OcpiTransportError,
  OcpiUnauthorizedError,
} from "@/lib/ocpi/errors";

/**
 * Every error the admin web shows carries a code and a next step. The code is the
 * peer's OCPI status_code when there is one (`OCPI 2001`), else the HTTP status the peer
 * answered with (`HTTP 401`), else one of our own short codes (`demo_mode`,
 * `invalid_input`, ...). The next step says what the admin can do about it. Neither
 * ever includes a token.
 */
export type Explained = { code: string; nextStep: string };

/** What to do about each OCPI 2.2.1 status code a CPO may answer with. */
export const OCPI_NEXT_STEP: Record<number, string> = {
  2000: "The CPO refused the request. Check the peer is registered and offers this module, then try again.",
  2001: "The CPO found a field invalid or missing (its message says which). Fix it and try again.",
  2002: "The CPO needs more information than we sent. Check the request is complete, then try again.",
  2003: "The CPO does not know that location. Pull its locations again (CPO peers), then retry.",
  2004: "The CPO does not know that token. Retry missed pushes (Drivers and tokens), then try again.",
  3000: "The CPO failed on a valid request. Try again later; if it repeats, send the CPO the time and request.",
  3001: "The CPO could not use our OCPI API. Check our versions URL is public over HTTPS, then rotate tokens.",
  3002: "No OCPI version in common: this server speaks 2.2.1 only. Ask the CPO to offer 2.2.1.",
  3003: "No matching endpoints. Ask the CPO to offer the modules needed, then rotate tokens to read them again.",
  4000: "A hub between us and the CPO failed. Try again later.",
  4001: "The hub does not know the receiving party. Check the CPO's country code and party ID.",
  4002: "The hub timed out forwarding the request. Try again later.",
  4003: "The hub could not reach the CPO. Try again later.",
};

const ocpiNextStep = (statusCode: number) =>
  OCPI_NEXT_STEP[statusCode] ??
  (statusCode >= 4000
    ? OCPI_NEXT_STEP[4000]
    : statusCode >= 3000
      ? OCPI_NEXT_STEP[3000]
      : OCPI_NEXT_STEP[2000]);

const UNAUTHORIZED =
  "The CPO refused our token. Rotate tokens (CPO peers); if that is refused too, register at the CPO again with a new Token A.";
const NO_RESPONSE: Explained = {
  code: "no_ocpi_response",
  nextStep:
    "The CPO gave no OCPI answer (down, timed out, or not an OCPI URL). Check its versions URL and try again later.",
};
const NOT_SENT: Explained = {
  code: "not_sent",
  nextStep:
    "Nothing was sent: this server only calls public HTTPS addresses. Check the CPO's versions URL.",
};
export const DEMO_MODE: Explained = {
  code: "demo_mode",
  nextStep:
    "Demo mode never contacts a CPO or charges a card. Set the live-mode variables (README: Connect real services) to do this for real.",
};
export const INVALID_INPUT: Explained = {
  code: "invalid_input",
  nextStep: "Check the fields above and send the form again.",
};
export const NOT_FOUND: Explained = {
  code: "not_found",
  nextStep: "Check the ID: copy it from a list on this page or look it up.",
};
export const UNEXPECTED: Explained = {
  code: "unexpected",
  nextStep:
    "Reload the list to see what happened before trying again. The server log has the error name.",
};

/** The code of an OCPI or HTTP status the peer answered with, with its next step. */
export function explainStatus(
  statusCode?: number,
  httpStatus?: number,
): Explained | null {
  if (httpStatus === 401 || httpStatus === 403)
    return {
      code: statusCode ? `OCPI ${statusCode}` : `HTTP ${httpStatus}`,
      nextStep: UNAUTHORIZED,
    };
  if (statusCode)
    return { code: `OCPI ${statusCode}`, nextStep: ocpiNextStep(statusCode) };
  if (httpStatus)
    return {
      code: `HTTP ${httpStatus}`,
      nextStep:
        httpStatus >= 500
          ? "The CPO failed. Try again later."
          : NO_RESPONSE.nextStep,
    };
  return null;
}

/**
 * The code and next step of an error message: the OCPI client writes the peer's
 * "OCPI status 2001" and "HTTP 401" into its messages, which handshake and pull errors
 * (and the stored result of the last pull) keep.
 */
export function explainMessage(message: string): Explained {
  if (message.startsWith("Demo mode:")) return DEMO_MODE;
  const ocpi = /OCPI status (\d{4})/.exec(message);
  const http = /HTTP (\d{3})/.exec(message);
  const known = explainStatus(
    ocpi ? Number(ocpi[1]) : undefined,
    http ? Number(http[1]) : undefined,
  );
  if (known) return known;
  if (/\brefused: /.test(message)) return NOT_SENT;
  if (
    /without an OCPI response|too large a body|did not answer|timed out/.test(
      message,
    )
  )
    return NO_RESPONSE;
  if (/^No such\b/.test(message)) return NOT_FOUND;
  if (/unexpected error/.test(message)) return UNEXPECTED;
  return INVALID_INPUT;
}

/** The code and next step of anything an admin action threw. */
export function explain(e: unknown): Explained {
  if (e && typeof e === "object" && "code" in e && e.code === "demo_mode")
    return DEMO_MODE;
  if (e instanceof OcpiUnauthorizedError)
    return explainStatus(e.statusCode, e.httpStatus ?? 401)!;
  if (e instanceof OcpiNotSentError) return NOT_SENT;
  if (e instanceof OcpiTransportError)
    return explainStatus(undefined, e.httpStatus) ?? NO_RESPONSE;
  if (e instanceof OcpiError)
    return explainStatus(e.statusCode, e.httpStatus) ?? NO_RESPONSE;
  if (!(e instanceof Error)) return UNEXPECTED;
  if (e instanceof SyncError)
    return (
      explainStatus(e.statusCode, e.httpStatus) ?? explainMessage(e.message)
    );
  if (e.name === "PaymentError") return explainPayment(e);
  return explainMessage(e.message);
}

function explainPayment(e: Error): Explained {
  const httpStatus = (e as { httpStatus?: number }).httpStatus ?? 400;
  if (httpStatus === 404) return NOT_FOUND;
  if (httpStatus === 409)
    return {
      code: "request_reused",
      nextStep:
        "This form's request ID was used for another amount; the form now has a new one. Look the payment up, then send the refund again if it is still needed.",
    };
  if (httpStatus === 502)
    return {
      code: "stripe_no_answer",
      nextStep:
        "Stripe did not answer, so the outcome is unknown. Look the payment up, then send the same form again if it is still needed.",
    };
  if (httpStatus === 503)
    return {
      code: "payments_not_set_up",
      nextStep: "Set STRIPE_SECRET_KEY on the server (README: Payments).",
    };
  const stripe = /Stripe refused the refund \(([a-z_]+)\)/.exec(e.message);
  if (stripe)
    return {
      code: `stripe_${stripe[1]}`,
      nextStep:
        "Stripe refused it; nothing was refunded. Check the payment in the Stripe Dashboard before trying again.",
    };
  if (/more than what is left/.test(e.message))
    return {
      code: "above_captured",
      nextStep:
        "Refunds are capped at what was captured. Look the payment up to see what is left.",
    };
  if (/Only a (captured|held) payment/.test(e.message))
    return {
      code: "wrong_status",
      nextStep: "Look the payment up to see its status first.",
    };
  return INVALID_INPUT;
}
