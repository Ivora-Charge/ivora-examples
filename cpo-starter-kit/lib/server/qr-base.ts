import "server-only";

// Adapted from installer-kit (templates do not share code). QR stickers outlive any
// app version or platform, so they point at the deployer's own domain: never Ivora, a
// hosting provider's default domain or a link shortener.

export const IVORA_DOMAINS = ["ivoracharge.com", "ivoracharge.co"];

const BORROWED_DOMAINS = [
  // Hosting providers' default domains change when you move or rename a project.
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "herokuapp.com",
  "onrender.com",
  "fly.dev",
  "supabase.co",
  // Third-party shorteners can expire or be re-pointed by someone else.
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
];

const matches = (host: string, domain: string) =>
  host === domain || host.endsWith(`.${domain}`);

const normalHost = (host: string) => host.toLowerCase().replace(/\.$/, "");

export function isIvoraHost(host: string): boolean {
  const h = normalHost(host);
  return IVORA_DOMAINS.some((d) => matches(h, d));
}

/** Why a base URL is not fit for printed QR codes, or null if it is. */
export function printableBaseProblem(raw: string, name: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${name} is not a valid URL.`;
  }
  const host = normalHost(url.hostname);
  if (url.protocol !== "https:")
    return `${name} must use https:// so printed codes open securely.`;
  if (url.username || url.password || url.search || url.hash)
    return `${name} must not contain credentials, a query or a fragment.`;
  if (url.pathname !== "/")
    return `${name} must be an origin only (no path), for example https://charge.example.com.`;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^[\d.]+$/.test(host) ||
    host.includes(":") ||
    !host.includes(".")
  )
    return `${name} must be a public domain name, not localhost or an IP address.`;
  if (isIvoraHost(host))
    return `${name} must be your own domain, not an Ivora domain.`;
  if (BORROWED_DOMAINS.some((d) => matches(host, d)))
    return `${name} must be a domain you own, not ${host}: stickers would break if that address changes.`;
  return null;
}

export type QrBase =
  { ok: true; base: string; demo: boolean } | { ok: false; reason: string };

/**
 * The origin printed in QR codes: PUBLIC_BASE_URL, else APP_URL, only as set
 * explicitly (never the hosting provider's default URL). Live mode refuses to print
 * until it is a stable HTTPS origin of your own, and preview deployments never print
 * (their codes would not exist in production). Demo mode falls back to the current
 * address; those stickers are marked as demo.
 */
export function resolveQrBase(opts: {
  env?: Record<string, string | undefined>;
  demo: boolean;
  requestOrigin: string;
}): QrBase {
  const env = opts.env ?? process.env;
  const pick = (k: string) => (env[k]?.trim() ? k : null);
  const name = pick("PUBLIC_BASE_URL") ?? pick("APP_URL");
  if (!opts.demo && env.VERCEL_ENV?.trim() === "preview")
    return {
      ok: false,
      reason:
        "This is a preview deployment: its sticker codes would not exist in production. Print stickers from your production deployment.",
    };
  if (name) {
    const raw = env[name]!.trim();
    const problem = printableBaseProblem(raw, name);
    if (problem && !opts.demo) return { ok: false, reason: problem };
    if (!problem)
      return { ok: true, base: new URL(raw).origin, demo: opts.demo };
  }
  if (opts.demo)
    return {
      ok: true,
      base: opts.requestOrigin.replace(/\/+$/, ""),
      demo: true,
    };
  return {
    ok: false,
    reason:
      "Set PUBLIC_BASE_URL (or APP_URL) to your own stable HTTPS origin, for example https://charge.example.com, before printing stickers.",
  };
}

/** The URL in a sticker's QR code. */
export function stickerUrl(base: string, code: string): string {
  return `${base.replace(/\/+$/, "")}/c/${encodeURIComponent(code)}`;
}
