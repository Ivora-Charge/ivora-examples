import "server-only";
import { describeError, ivora, type TransactionDetail } from "./ivora";
import {
  applyProfileStatus,
  endSession,
  logEvent,
  now,
  replan,
  startSession,
  stationConnectors,
  type Depot,
} from "./depot";
import type { IvoraEvent } from "./webhook";

/**
 * Handle one verified, deduplicated webhook event (live mode). Ivora has no
 * transaction start/stop event: a session starts with the first meter.sampled of a
 * transaction and ends when its connector leaves Charging and the transaction reads
 * inactive. Events are signals; the current state is read from the API.
 */
export async function handleEvent(d: Depot, e: IvoraEvent): Promise<void> {
  const x = e.data;
  switch (e.type) {
    case "meter.sampled":
      return onMeterSample(d, x);
    case "connector.status_changed":
      return onConnectorStatus(d, x);
    case "charging_profile.accepted":
    case "charging_profile.rejected":
    case "charging_profile.cleared":
      return onProfileAnswer(d, e.type, x);
    case "token.updated":
      return onTokenUpdated(d, x);
    default:
      await logEvent(d, e.type, "received, not used by this app");
  }
}

const int = (v: unknown) =>
  typeof v === "number" && Number.isInteger(v) ? v : undefined;
const dec = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};

async function sessionByTransaction(d: Depot, transactionId: number) {
  return (await d.store.list("sessions")).find(
    (s) => s.transactionId === transactionId,
  );
}

/** Match a masked card (****1234) to exactly one driver's vehicle; ambiguous stays unknown. */
export function matchVehicle(
  hint: string | null | undefined,
  drivers: { id: string; idTag?: string }[],
  vehicles: { id: string; driverId?: string }[],
): string | undefined {
  const last4 = hint?.replace(/^\*+/, "").toUpperCase();
  if (!last4 || last4.length < 4) return undefined;
  const hits = drivers.filter((p) => p.idTag?.toUpperCase().endsWith(last4));
  if (hits.length !== 1) return undefined;
  const cars = vehicles.filter((v) => v.driverId === hits[0].id);
  return cars.length === 1 ? cars[0].id : undefined;
}

async function startFromTransaction(d: Depot, tx: TransactionDetail) {
  if (!tx.station_id || !tx.connector_id) return;
  const api = ivora();
  const station = await api.getStation(tx.station_id).catch(() => undefined);
  const conn = station?.connectors.find((c) => c.id === tx.connector_id);
  const [drivers, vehicles] = await Promise.all([
    d.store.list("drivers"),
    d.store.list("vehicles"),
  ]);
  await startSession(d, {
    vehicleId: matchVehicle(tx.id_token, drivers, vehicles),
    idTokenHint: tx.id_token ?? undefined,
    stationId: tx.station_id,
    stationName: station?.name,
    protocol: station?.protocol ?? undefined,
    connectorId: tx.connector_id,
    connectorNumber: tx.connector_number ?? conn?.number ?? undefined,
    connectorKw: conn?.max_power_w ? conn.max_power_w / 1000 : undefined,
    connectors: station && stationConnectors(station),
    transactionId: tx.id,
    meterStartWh: tx.meter_start_wh ?? 0,
    startedAt: tx.started_at ?? undefined,
  });
}

async function onMeterSample(d: Depot, x: Record<string, unknown>) {
  const txId = int(x.transaction_id);
  if (!txId) return;
  let s = await sessionByTransaction(d, txId);
  if (!s) {
    const tx = await ivora().getTransaction(txId);
    if (!tx.active) return;
    await startFromTransaction(d, tx);
    s = await sessionByTransaction(d, txId);
    if (!s) return;
  }
  const wh = int(x.energy_wh);
  if (wh !== undefined && wh >= s.meterWh) s.meterWh = wh;
  const soc = dec(x.soc_percent);
  if (soc !== undefined) s.reportedSocPercent = soc;
  await d.store.put("sessions", s.id, s);
  if (x.context === "Transaction.End") await finish(d, s.id, txId);
}

async function finish(d: Depot, sessionId: string, txId: number) {
  const tx = await ivora().getTransaction(txId);
  if (tx.active) return;
  await endSession(d, sessionId, tx.energy_wh ?? undefined);
}

async function onConnectorStatus(d: Depot, x: Record<string, unknown>) {
  const connectorId = int(x.connector_id);
  const status = String(x.status ?? "");
  const s = (await d.store.list("sessions")).find(
    (y) => y.connectorId === connectorId,
  );
  if (!s?.transactionId) return;
  if (["Available", "Finishing", "Faulted", "Unavailable"].includes(status))
    await finish(d, s.id, s.transactionId);
}

async function onProfileAnswer(
  d: Depot,
  type: string,
  x: Record<string, unknown>,
) {
  const profile = (x.profile ?? {}) as {
    id?: string;
    error?: { code?: string; message?: string } | null;
  };
  const sessions = await d.store.list("sessions");
  const s = sessions.find((y) =>
    y.sent?.some((p) => p.profileId === profile.id),
  );
  const charger =
    typeof x.charger_status === "string" ? x.charger_status : null;
  const c = s
    ? undefined
    : (await d.store.list("chargers")).find((y) =>
        y.sent?.some((p) => p.profileId === profile.id),
      );
  if (c) {
    applyProfileStatus(
      c,
      c.sent!.find((y) => y.profileId === profile.id)!,
      type.slice("charging_profile.".length),
      now(d),
      profile.error?.code,
    );
    await d.store.put("chargers", c.id, c);
  }
  if (s) {
    const p = s.sent!.find((y) => y.profileId === profile.id)!;
    applyProfileStatus(s, p, type.slice("charging_profile.".length), now(d));
    if (type === "charging_profile.rejected" && s.profile?.key === p.key)
      s.profile.detail = profile.error?.code
        ? `${profile.error.code}: ${profile.error.message ?? ""}`
        : `charger answered ${charger ?? "Rejected"}`;
    await d.store.put("sessions", s.id, s);
  }
  await logEvent(
    d,
    type,
    `${s ? `session on connector ${s.connectorNumber ?? s.connectorId}` : c ? `baseline of station ${c.stationId}` : `profile ${profile.id ?? "?"}`}${charger ? ` (${charger})` : ""}`,
  );
  // An accepted lower limit may unblock raises that were waiting for it.
  if (s || c) await replan(d);
}

async function onTokenUpdated(d: Depot, x: Record<string, unknown>) {
  const token = (x.token ?? {}) as { id?: number; status?: string };
  const drv = (await d.store.list("drivers")).find(
    (p) => p.tokenId !== undefined && p.tokenId === token.id,
  );
  if (!drv) return;
  drv.cardBlocked = token.status === "Blocked" || token.status === "Expired";
  await d.store.put("drivers", drv.id, drv);
  await logEvent(d, "token.updated", `${drv.name}: ${token.status}`);
}

/** Run a handler and record failures instead of throwing (the delivery is already acknowledged). */
export async function handleSafely(d: Depot, e: IvoraEvent) {
  try {
    await handleEvent(d, e);
  } catch (err) {
    await logEvent(
      d,
      "webhook.error",
      `${e.type} ${e.id}: ${describeError(err)}`,
    );
    // Keep the board consistent with whatever did change.
    await replan(d).catch(() => undefined);
  }
}
