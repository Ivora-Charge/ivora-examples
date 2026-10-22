import { normaliseId } from "./search";

/**
 * What a charger's QR code (or a typed code) names. Operators print different things:
 * the bare EVSE ID (`NL*ABC*E12345`, eMI3 format), a link with the EVSE ID in its
 * query (`?evse=…`, `?evseid=…`, `?evse_id=…`, `?id=…`) or as its last path segment, or
 * a short charger reference (`A1`). The result is searched like the search box does,
 * so separators and case do not matter. Null for anything that cannot be an ID.
 */
const QUERY_KEYS = ["evse", "evseid", "evse_id", "evseId", "id", "c", "cp"];

const plausible = (v: string) => {
  const id = normaliseId(v);
  return id.length >= 2 && id.length <= 48 ? v.trim() : null;
};

export function chargerCode(raw: string): string | null {
  const text = raw.trim().slice(0, 500);
  if (!text) return null;
  let url: URL | undefined;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) url = new URL(text);
  } catch {}
  if (url) {
    for (const key of QUERY_KEYS) {
      const v = url.searchParams.get(key);
      if (v) return plausible(decodeURIComponent(v));
    }
    const last = url.pathname.split("/").filter(Boolean).at(-1);
    return last ? plausible(decodeURIComponent(last)) : null;
  }
  // Plain text: an ID has letters, digits and the usual separators only.
  if (!/^[A-Za-z0-9*\-_. ]+$/.test(text)) return null;
  return plausible(text);
}

/**
 * The EVSE of a location a code names: by its EVSE ID, then by the charger's own
 * reference, the EVSE's uid, or the location's ID. Undefined when none matches, so the
 * driver picks the connector themselves.
 */
export function evseForCode<
  E extends { uid: string; evse_id?: string; physical_reference?: string },
>(evses: E[], code: string): E | undefined {
  const id = normaliseId(code);
  return (
    evses.find((e) => e.evse_id && normaliseId(e.evse_id) === id) ??
    evses.find(
      (e) =>
        (e.physical_reference && normaliseId(e.physical_reference) === id) ||
        normaliseId(e.uid) === id,
    )
  );
}
