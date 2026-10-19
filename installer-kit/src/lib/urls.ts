const DEFAULT_QR_BASE = "http://localhost:3000";

/** Sticker URLs live on the deployer's own domain, never an Ivora domain. */
export function qrBase(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = (env.QR_BASE_URL || DEFAULT_QR_BASE).trim().replace(/\/+$/, "");
  return raw;
}

export function stickerUrl(
  chargerId: string,
  connectorId: number,
  base = qrBase(),
): string {
  return `${base}/c/${encodeURIComponent(chargerId)}/${connectorId}`;
}

/** OCPP 1.6J connection URL: endpoint + station identity (no password inside). */
export function ocppConnectionUrl(endpoint: string, stationId: string): string {
  return `${endpoint.replace(/\/+$/, "")}/${encodeURIComponent(stationId)}`;
}

/** Throws if a base would put stickers on an Ivora-operated domain. */
export function assertNotIvoraDomain(base: string): void {
  const host = new URL(base).hostname.toLowerCase();
  if (
    host === "ivora.io" ||
    host.endsWith(".ivora.io") ||
    host.includes("ivora-charge")
  ) {
    throw new Error("QR_BASE_URL must be your own domain, not an Ivora domain");
  }
}
