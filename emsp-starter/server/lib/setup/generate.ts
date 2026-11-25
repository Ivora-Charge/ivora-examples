/**
 * New values for the two random settings an operator would otherwise have to make by
 * hand, for the Setup page's Generate buttons.
 *
 * For the browser: the values come from its Web Crypto, and nothing here sends, stores
 * or logs them. Keep this file without imports, so it never takes anything of the
 * server into the page. lib/server/config.ts says what each value must look like; a
 * test holds the two together (tests/setup-generate.test.ts).
 */
export const GENERATED_SETTINGS = [
  "OCPI_TOKEN_ENCRYPTION_KEY",
  "CRON_SECRET",
] as const;

export type GeneratedSetting = (typeof GENERATED_SETTINGS)[number];

/** 32 random bytes in standard base64, as `openssl rand -base64 32` writes them. */
function randomBase64(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * A new value for `name`, from 32 random bytes. The key is base64, which is what the
 * server decodes; the job's secret travels in an `Authorization` header, so it takes
 * the URL-safe alphabet and no padding (43 characters).
 */
export function generateSetting(name: GeneratedSetting): string {
  const value = randomBase64();
  return name === "CRON_SECRET"
    ? value.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
    : value;
}
