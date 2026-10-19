import { createHmac, timingSafeEqual } from "node:crypto";

// Small signed values for cookies: `<payload>.<expiry ms>.<hmac>`. The payload
// is not secret; the signature proves this server issued it.

function mac(
  secret: string,
  purpose: string,
  payload: string,
  expires: number,
) {
  return createHmac("sha256", secret)
    .update(`${purpose}\n${payload}\n${expires}`)
    .digest("base64url");
}

export function signToken(
  secret: string,
  purpose: string,
  payload: string,
  expires: number,
) {
  if (!secret) throw new Error("A signing secret is required.");
  if (payload.includes(".")) throw new Error("Payload cannot contain dots.");
  return `${payload}.${expires}.${mac(secret, purpose, payload, expires)}`;
}

/** Returns the payload when the token is genuine and unexpired. */
export function verifyToken(
  secret: string,
  purpose: string,
  token: string | undefined,
  now = Date.now(),
): string | null {
  if (!secret || !token) return null;
  const [payload, expiresText, signature, extra] = token.split(".");
  if (!payload || !expiresText || !signature || extra !== undefined)
    return null;
  if (!/^\d+$/.test(expiresText)) return null;
  const expires = Number(expiresText);
  const expected = Buffer.from(mac(secret, purpose, payload, expires));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    return null;
  return expires > now ? payload : null;
}

/** Constant-time password check (lengths leak nothing useful: both are hashed). */
export function passwordMatches(given: string, expected: string) {
  if (!expected) return false;
  const a = createHmac("sha256", "operator-password").update(given).digest();
  const b = createHmac("sha256", "operator-password").update(expected).digest();
  return timingSafeEqual(a, b);
}
