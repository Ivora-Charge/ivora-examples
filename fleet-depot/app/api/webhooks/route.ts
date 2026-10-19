import { endSession, getDepot, logEvent, startSession } from "@/lib/depot";
import { config } from "@/lib/config";
import { verifySignature } from "@/lib/webhook";

// Header name: see the webhooks page of the developer portal.
const SIG_HEADER = "x-ivora-signature";

interface Evt {
  type: string;
  data?: {
    stationId?: string;
    connectorId?: number;
    idTag?: string;
    meterStartWh?: number;
    meterStopWh?: number;
    detail?: string;
  };
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (
    !verifySignature(raw, req.headers.get(SIG_HEADER), config.webhookSecret)
  ) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }
  const d = await getDepot();
  const evt = JSON.parse(raw) as Evt;
  const x = evt.data ?? {};
  const drivers = await d.store.list("drivers");
  const vehicles = await d.store.list("vehicles");
  const driver = drivers.find((p) => p.idTag === x.idTag);
  const vehicle = vehicles.find((v) => v.driverId === driver?.id);

  if (evt.type === "transaction.started" && vehicle && x.stationId) {
    await startSession(
      d,
      vehicle,
      x.stationId,
      x.connectorId ?? 1,
      x.meterStartWh ?? 0,
    );
  } else if (
    evt.type === "transaction.stopped" ||
    evt.type === "transaction.ended"
  ) {
    const s = (await d.store.list("sessions")).find(
      (p) => p.stationId === x.stationId && p.connectorId === x.connectorId,
    );
    if (s) await endSession(d, s.id, x.meterStopWh);
  } else if (
    evt.type === "charging_profile.accepted" ||
    evt.type === "charging_profile.rejected"
  ) {
    const s = (await d.store.list("sessions")).find(
      (p) => p.stationId === x.stationId && p.connectorId === x.connectorId,
    );
    if (s) {
      s.profile = {
        status: evt.type.endsWith("accepted") ? "accepted" : "rejected",
        at: new Date().toISOString(),
        detail: x.detail,
        composite: s.profile?.composite,
      };
      await d.store.put("sessions", s.id, s);
    }
    await logEvent(d, evt.type, x.detail ?? `${x.stationId}/${x.connectorId}`);
  } else {
    await logEvent(d, evt.type, "ignored");
  }
  return Response.json({ ok: true });
}
