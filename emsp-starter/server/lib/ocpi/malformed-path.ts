/**
 * Whether a path under `/ocpi` cannot name any OCPI endpoint: a percent-escape that does
 * not decode, or a decoded segment with a backslash, a control character or a dot
 * segment. Such a request is answered 404 before routing, so the framework never has
 * to match it (a malformed escape in a catch-all segment otherwise ends in a 500).
 */
export function isMalformedOcpiPath(pathname: string): boolean {
  for (const raw of pathname.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return true;
    }
    // eslint-disable-next-line no-control-regex
    if (/[\\\u0000-\u001f\u007f]/.test(segment)) return true;
    if (segment === "." || segment === "..") return true;
  }
  return false;
}
