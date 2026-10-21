/** A body over the size limit. Reading stopped at the limit; nothing more was buffered. */
export class BodyTooLargeError extends Error {
  constructor() {
    super("Body too large");
    this.name = "BodyTooLargeError";
  }
}

/**
 * Reads a request or response body as UTF-8 text, at most `maxBytes`. A Content-Length
 * over the limit is refused before reading; otherwise the stream is cancelled as soon
 * as it passes the limit.
 */
export async function readLimitedText(
  message: Request | Response,
  maxBytes: number,
): Promise<string> {
  const declared = message.headers.get("Content-Length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await message.body?.cancel().catch(() => undefined);
    throw new BodyTooLargeError();
  }
  if (!message.body) return "";
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}
