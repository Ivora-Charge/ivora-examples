/**
 * A driver reference as it appears in URLs: the account ID (the Supabase Auth user
 * ID), or any other reference a token was made for. Printable ASCII without spaces,
 * 64 characters at most, as tokens take it.
 */
const REFERENCE = /^[\x21-\x7e]{1,64}$/;

export const isDriverReference = (v: unknown): v is string =>
  typeof v === "string" && REFERENCE.test(v);

/** The driver's page. */
export const driverHref = (ref: string) =>
  `/admin/drivers/${encodeURIComponent(ref)}`;

/** The reference in the path of a driver's page, or null when it is none. */
export function referenceFromPath(segment: string): string | null {
  let ref: string;
  try {
    ref = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return isDriverReference(ref) ? ref : null;
}
