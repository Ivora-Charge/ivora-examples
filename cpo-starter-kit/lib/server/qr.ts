import "server-only";
import { headers } from "next/headers";
import QRCode from "qrcode";
import { isDemo } from "./env";
import { resolveQrBase, type QrBase } from "./qr-base";

/**
 * Where printed QR codes point, for this request. Demo mode may fall back to the
 * address the page was opened on (its stickers are marked as demo); live mode needs
 * PUBLIC_BASE_URL or APP_URL (see qr-base.ts).
 */
export async function qrBase(): Promise<QrBase> {
  const h = await headers();
  const host = h.get("host") ?? "localhost";
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  return resolveQrBase({ demo: isDemo(), requestOrigin: `${proto}://${host}` });
}

/** An SVG QR code, generated on the server (no third-party QR service). */
export function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
  });
}
