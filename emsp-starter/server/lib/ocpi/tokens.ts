import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { config } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { TOKEN_PATTERN } from "./schema";

/**
 * Credentials tokens. Tokens we issue to peers are stored only as SHA-256 hashes;
 * tokens peers issue to us are stored encrypted with AES-256-GCM. Token values are
 * secrets: never log them or put them in errors.
 */

/** A new token for a peer: 256 random bits, base64url (43 characters, under OCPI's 64). */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Tokens are 256-bit random, so a plain SHA-256 is enough to make the stored hash useless. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** The OCPI 2.2.1 Authorization header: `Token <base64(token)>`. */
export function authorizationHeader(token: string): string {
  return `Token ${Buffer.from(token, "utf8").toString("base64")}`;
}

/**
 * Token values an Authorization header may carry. OCPI 2.2.1 base64-encodes the token;
 * peers still on the 2.1.1 convention send it as is, so both readings are tried.
 */
export function tokensFromHeader(header: string | null): string[] {
  const m = /^Token\s+(\S+)\s*$/i.exec(header ?? "");
  if (!m) return [];
  const raw = m[1];
  const out = new Set<string>();
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(raw) && raw.length % 4 === 0) {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    if (TOKEN_PATTERN.test(decoded)) out.add(decoded);
  }
  if (TOKEN_PATTERN.test(raw)) out.add(raw);
  return [...out];
}

const FORMAT = "v1";
const demoKey = globalThis as unknown as { __emspDemoTokenKey?: Buffer };

function encryptionKey(): Buffer {
  const key = config.tokenEncryptionKey;
  if (key) return key;
  // Demo mode keeps peers in memory only, so a per-process key is enough.
  if (isDemo()) return (demoKey.__emspDemoTokenKey ??= randomBytes(32));
  throw new Error("OCPI_TOKEN_ENCRYPTION_KEY is not set");
}

/**
 * Encrypts a peer's token for storage. `context` (the peer ID) is bound as associated
 * data, so a ciphertext copied to another peer's row does not decrypt.
 */
export function encryptToken(token: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ct = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [FORMAT, iv, ct, cipher.getAuthTag()]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(":");
}

export function decryptToken(stored: string, context: string): string {
  const [format, iv, ct, tag] = stored.split(":");
  if (format !== FORMAT || !iv || !ct || !tag)
    throw new Error("Stored peer token has an unknown format");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(iv, "base64url"),
    // Refuse truncated tags.
    { authTagLength: 16 },
  );
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ct, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Stored peer token could not be decrypted");
  }
}
