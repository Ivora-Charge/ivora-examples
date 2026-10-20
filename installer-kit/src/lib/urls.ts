/**
 * Stickers outlive any app version or platform, so QR codes point at the
 * deployer's own domain: never Ivora, a hosting provider's default domain or
 * a link shortener.
 */
export const IVORA_DOMAINS = ["ivoracharge.com", "ivoracharge.co"];

const BORROWED_DOMAINS = [
  // Hosting providers' default domains change when you move or rename a project.
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "herokuapp.com",
  "onrender.com",
  "fly.dev",
  // Third-party shorteners can expire or be re-pointed by someone else.
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
];

const matches = (host: string, domain: string) =>
  host === domain || host.endsWith(`.${domain}`);

function normalHost(host: string) {
  return host.toLowerCase().replace(/\.$/, "");
}

export function isIvoraHost(host: string): boolean {
  const h = normalHost(host);
  return IVORA_DOMAINS.some((d) => matches(h, d));
}

/** Throws if a base would put stickers on an Ivora-operated domain. */
export function assertNotIvoraDomain(base: string): void {
  if (isIvoraHost(new URL(base).hostname))
    throw new Error(
      "QR_BASE_URL must be your own domain, not an Ivora domain (ivoracharge.com, ivoracharge.co or a subdomain).",
    );
}

/** Returns why a base URL is not fit for printed QR codes, or null if it is. */
export function printableBaseProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "QR_BASE_URL is not a valid URL.";
  }
  const host = normalHost(url.hostname);
  if (url.protocol !== "https:")
    return "QR_BASE_URL must use https:// so printed codes open securely.";
  if (url.username || url.password || url.search || url.hash)
    return "QR_BASE_URL must not contain credentials, a query or a fragment.";
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^[\d.]+$/.test(host) ||
    host.includes(":")
  )
    return "QR_BASE_URL must be a public domain name, not localhost or an IP address.";
  if (isIvoraHost(host))
    return "QR_BASE_URL must be your own domain, not an Ivora domain.";
  if (BORROWED_DOMAINS.some((d) => matches(host, d)))
    return `QR_BASE_URL must be a domain you own, not ${host}: stickers would break if that address changes.`;
  return null;
}

export type QrBase =
  { ok: true; base: string; demo: boolean } | { ok: false; reason: string };

/**
 * Live mode prints codes only on a configured, stable HTTPS origin. Demo mode
 * may fall back to the current origin; those stickers are marked DEMO.
 */
export function resolveQrBase(opts: {
  env?: Record<string, string | undefined>;
  demo: boolean;
  requestOrigin: string;
}): QrBase {
  const raw = (opts.env ?? process.env).QR_BASE_URL?.trim();
  if (raw) {
    const problem = printableBaseProblem(raw);
    if (problem) return { ok: false, reason: problem };
    return { ok: true, base: raw.replace(/\/+$/, ""), demo: opts.demo };
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
      "Set QR_BASE_URL to your own stable HTTPS origin (for example https://charge.example.com) before printing stickers.",
  };
}

export function stickerUrl(base: string, code: string): string {
  return `${base.replace(/\/+$/, "")}/s/${encodeURIComponent(code)}`;
}
