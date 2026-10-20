import { guard } from "@/lib/auth";
import { getDepot, logEvent, replan, withLock } from "@/lib/depot";
import { UserError } from "@/lib/drivers";
import { body, fail, json } from "@/lib/http";

/** Assign a session whose card did not match a vehicle: {sessionId, vehicleId}. */
export async function POST(req: Request) {
  const denied = guard(req, { write: true });
  if (denied) return denied;
  try {
    const d = await getDepot();
    const b = await body<{ sessionId: string; vehicleId: string }>(req);
    return await withLock(async () => {
      const sessions = await d.store.list("sessions");
      const s = sessions.find((x) => x.id === b.sessionId);
      const v = (await d.store.list("vehicles")).find(
        (x) => x.id === b.vehicleId,
      );
      if (!s || !v) throw new UserError("session or vehicle not found", 404);
      if (sessions.some((x) => x.vehicleId === v.id))
        throw new UserError(`${v.name} is already plugged in`);
      s.vehicleId = v.id;
      await d.store.put("sessions", s.id, s);
      await logEvent(
        d,
        "session.assigned",
        `${v.name} on connector ${s.connectorNumber ?? s.connectorId}`,
      );
      await replan(d);
      return json({ ok: true });
    });
  } catch (e) {
    return fail(e);
  }
}
