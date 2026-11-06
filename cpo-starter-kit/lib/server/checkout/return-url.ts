import { isIP } from "node:net";

/** Ivora accepts a return_url of at most this many characters. */
export const RETURN_URL_MAX = 512;

/** What the driver session page's address looks like (the checkout's random ID). */
export const SESSION_PATH = "/s/";

/**
 * The payment's return_url for a checkout: `<origin>/s/<checkout id>`, or null when the
 * origin can't be a return domain: it must be https on the default port, a hostname (no
 * IP address), carry no credentials or fragment, and the whole URL must fit Ivora's
 * 512 characters.
 */
export function sessionReturnUrl(
  origin: string | null | undefined,
  checkoutId: string,
): string | null {
  if (!origin) return null;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return null;
  }
  // Ivora's canonical form has the default port only (`new URL` drops :443 itself):
  // any other port is refused with a 422, which no fallback catches.
  if (u.protocol !== "https:" || u.username || u.password || u.hash || u.port)
    return null;
  // new URL keeps IPv6 brackets in `hostname`; isIP wants them off.
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host || isIP(host) !== 0) return null;
  // The decimal and hex forms of an IPv4 address (http://2130706433/) parse to dotted
  // quads above, so they are caught by isIP; a bare label has no dot to verify.
  if (!host.includes(".")) return null;
  const url = `${u.origin}${SESSION_PATH}${encodeURIComponent(checkoutId)}`;
  return url.length <= RETURN_URL_MAX ? url : null;
}

/** The TXT record that proves a hostname: name and value. */
export function returnTxtRecord(hostname: string, token: string) {
  return {
    name: `_ivora-return.${hostname}`,
    value: `ivora-return-verification=${token}`,
  };
}

/** Shown when Ivora refuses the return_url and the kit uses Ivora's driver page. */
export const RETURN_FALLBACK_MESSAGE =
  "Your hostname is not verified as a return domain yet, so drivers were sent back to Ivora's driver page instead of your own. Finish Onboarding, Return domain: publish the TXT record, then verify it.";
