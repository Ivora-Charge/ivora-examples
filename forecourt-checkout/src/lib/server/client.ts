import "server-only";

/**
 * The caller's address from a trusted source, or null when there is none. Every
 * rate limit keys on this. A client can send any x-forwarded-for, so it is never
 * read on its own.
 *
 * - TRUSTED_PROXY_HEADER names a header your own proxy or CDN sets to the client
 *   address and that callers can't set themselves (for example
 *   `cf-connecting-ip`, `x-real-ip`, or the forwarded-for header from a proxy
 *   that appends to it). For a comma list, the last entry is used: the one your
 *   proxy added.
 * - On Vercel, without it, Vercel's own `x-vercel-forwarded-for`.
 * - Otherwise null: each limit decides what to do without an address.
 */
export function trustedClient(
  headers: Headers,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const name = env.TRUSTED_PROXY_HEADER?.trim().toLowerCase();
  if (name) {
    const parts = (headers.get(name) ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    return parts.at(-1) ?? null;
  }
  if (env.VERCEL === "1")
    return headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || null;
  return null;
}
