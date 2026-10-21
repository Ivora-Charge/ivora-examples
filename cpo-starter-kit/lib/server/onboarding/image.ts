import "server-only";
import type { LogoUpload } from "../ivora/types";
import { OnboardingError } from "./types";

// Logo checks before anything is sent to Ivora, with the same limits the API applies:
// PNG, JPEG or WebP (never SVG), at most 512 KB, 32 to 2048 px a side, not animated.
// The type comes from the file's own bytes, not its name or the browser's label.

import { LOGO_MAX_BYTES, LOGO_MAX_PX, LOGO_MIN_PX } from "@/lib/logo-limits";

export { LOGO_MAX_BYTES, LOGO_MAX_PX, LOGO_MIN_PX };

export interface ImageInfo {
  contentType: LogoUpload["contentType"];
  width: number;
  height: number;
  animated: boolean;
}

const ascii = (b: Uint8Array, at: number, n: number) =>
  String.fromCharCode(...b.subarray(at, at + n));
const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u32be = (b: Uint8Array, at: number) =>
  ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u24le = (b: Uint8Array, at: number) =>
  b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);

function png(b: Uint8Array): ImageInfo | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 33 || sig.some((v, i) => b[i] !== v)) return null;
  if (ascii(b, 12, 4) !== "IHDR") return null;
  // An acTL chunk before the image data makes it an animated PNG.
  let animated = false;
  for (let at = 8; at + 8 <= b.length;) {
    const len = u32be(b, at);
    const type = ascii(b, at + 4, 4);
    if (type === "acTL") animated = true;
    if (type === "IDAT" || type === "IEND") break;
    at += 12 + len;
  }
  return {
    contentType: "image/png",
    width: u32be(b, 16),
    height: u32be(b, 20),
    animated,
  };
}

function jpeg(b: Uint8Array): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  for (let at = 2; at + 9 < b.length;) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    if (marker === 0xff) {
      at++;
      continue;
    }
    // Start-of-frame markers carry the size (not DHT, JPG or DAC).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    )
      return {
        contentType: "image/jpeg",
        height: u16be(b, at + 5),
        width: u16be(b, at + 7),
        animated: false,
      };
    at += 2 + u16be(b, at + 2);
  }
  return null;
}

function webp(b: Uint8Array): ImageInfo | null {
  if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP")
    return null;
  const chunk = ascii(b, 12, 4);
  const info = (width: number, height: number, animated = false) => ({
    contentType: "image/webp" as const,
    width,
    height,
    animated,
  });
  if (chunk === "VP8 ")
    return info(
      (b[26] | (b[27] << 8)) & 0x3fff,
      (b[28] | (b[29] << 8)) & 0x3fff,
    );
  if (chunk === "VP8L")
    return info(
      1 + (((b[22] & 0x3f) << 8) | b[21]),
      1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)),
    );
  if (chunk === "VP8X")
    return info(1 + u24le(b, 24), 1 + u24le(b, 27), (b[20] & 0x02) !== 0);
  return null;
}

/** Type and size from the image's own header, or null when it is none of the three. */
export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  return png(bytes) ?? jpeg(bytes) ?? webp(bytes);
}

const invalid = (message: string) =>
  new OnboardingError("logo_invalid", message);

/** The upload to send, or an error that says what to fix. */
export function checkLogo(bytes: Uint8Array): LogoUpload {
  if (bytes.length > LOGO_MAX_BYTES)
    throw invalid("The logo is larger than 512 KB. Export a smaller image.");
  const info = imageInfo(bytes);
  if (!info)
    throw invalid(
      "Use a PNG, JPEG or WebP image for the logo. SVG isn't accepted, because it can carry script.",
    );
  const sides = [info.width, info.height];
  if (sides.some((n) => n < LOGO_MIN_PX || n > LOGO_MAX_PX))
    throw invalid(
      `The logo is ${info.width}×${info.height} px. Each side must be 32 to 2048 px.`,
    );
  if (info.animated)
    throw invalid("Use a still image: animated logos aren't accepted.");
  return { bytes, contentType: info.contentType };
}
