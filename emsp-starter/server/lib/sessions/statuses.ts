/**
 * Session statuses and the session search term, with no server-only imports, so the
 * stores, the admin actions and the browser's session list share one definition.
 */

/** Every status a session can have. */
export const SESSION_STATUSES = [
  "ACTIVE",
  "PENDING",
  "RESERVATION",
  "COMPLETED",
  "INVALID",
] as const;

/** Sessions still running, or about to: the "live" list. */
export const OPEN_SESSION_STATUSES: readonly string[] = [
  "ACTIVE",
  "PENDING",
  "RESERVATION",
];

/**
 * How many sessions match, in total and per status (a status with none is 0). With a
 * search term each status is counted up to SESSION_SEARCH_COUNT_CAP: `more` lists the
 * statuses that have more than their number, and `total` is then a lower bound too.
 */
export type SessionCounts = {
  total: number;
  byStatus: Record<string, number>;
  more: string[];
};

/**
 * The count behind a status filter of the list ("all", "live" or one status), and
 * whether there are more than that (a capped count of a search).
 */
export function filterCount(
  filter: string,
  c: SessionCounts,
): { n: number; more: boolean } {
  const statuses: readonly string[] =
    filter === "all"
      ? SESSION_STATUSES
      : filter === "live"
        ? OPEN_SESSION_STATUSES
        : [filter];
  return {
    n: statuses.reduce((n, s) => n + (c.byStatus[s] ?? 0), 0),
    more: statuses.some((s) => c.more.includes(s)),
  };
}

/** The longest search term. */
export const SESSION_SEARCH_MAX = 64;

/**
 * With a search term, each status is counted up to this many and then shown as
 * "1000+": a search cannot ask the database to count a whole table that matches.
 */
export const SESSION_SEARCH_COUNT_CAP = 1000;

/**
 * ASCII letters, digits, space and `. : @ / + - _` only. Nothing that means something
 * to PostgREST's `or=(...)` (comma, parentheses, quotes, backslash) or to a pattern
 * (`*`, `%`); no control characters and no look-alikes from outside ASCII. In a
 * pattern `_` still matches any one character, so "AB_1" also finds "AB-1".
 */
const SEARCH_TERM = new RegExp(
  `^[A-Za-z0-9 ._:@/+-]{1,${SESSION_SEARCH_MAX}}$`,
);

/**
 * The search text, trimmed, or null when it is empty, too long or has characters a
 * reference never has. The Supabase store checks this again itself.
 */
export function sessionSearchTerm(v: string): string | null {
  const t = v.trim();
  return SEARCH_TERM.test(t) ? t : null;
}

/**
 * The term a store may put in a query: exactly what `sessionSearchTerm` accepts, or it
 * throws. Each store checks for itself, whatever its caller did.
 */
export function checkedSearchTerm(term: string): string {
  if (sessionSearchTerm(term) !== term)
    throw new Error(
      "Session search refused: up to 64 letters, digits, spaces and . : @ / + - _ only.",
    );
  return term;
}

/** Whether `value` contains the (checked) term, any letter case, `_` any character. */
export function matchesSearch(value: string, term: string): boolean {
  const re = new RegExp(
    checkedSearchTerm(term)
      .toLowerCase()
      .replace(/[.+/]/g, "\\$&")
      .replaceAll("_", "."),
  );
  return re.test(value.toLowerCase());
}
