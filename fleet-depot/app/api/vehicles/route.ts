import { randomUUID } from "node:crypto";
import { guard } from "@/lib/auth";
import { getDepot, logEvent, replan, withLock } from "@/lib/depot";
import { UserError } from "@/lib/drivers";
import { body, fail, json } from "@/lib/http";
import type { Vehicle } from "@/lib/types";

type Input = Omit<Partial<Vehicle>, "need"> & {
  needKind: "kwh" | "battery";
  needValue: number;
};

const num = (v: unknown, min: number, max: number, what: string) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max)
    throw new UserError(`${what} must be between ${min} and ${max}`);
  return n;
};

/** Create a vehicle, or update one (departure, energy need, driver) and replan. */
export async function POST(req: Request) {
  const denied = guard(req, { write: true });
  if (denied) return denied;
  try {
    const d = await getDepot();
    const b = await body<Input>(req);
    return await withLock(async () => {
      const vehicles = await d.store.list("vehicles");
      const prev = b.id ? vehicles.find((v) => v.id === b.id) : undefined;
      if (b.id && !prev) throw new UserError("vehicle not found", 404);
      const name = String(b.name ?? prev?.name ?? "")
        .trim()
        .slice(0, 60);
      if (!name) throw new UserError("name is required");
      const v: Vehicle = {
        id: prev?.id ?? randomUUID(),
        name,
        plate: String(b.plate ?? prev?.plate ?? "").slice(0, 20),
        kind: (["van", "bus", "car", "truck"] as const).includes(
          b.kind as never,
        )
          ? (b.kind as Vehicle["kind"])
          : (prev?.kind ?? "van"),
        batteryKwh: num(
          b.batteryKwh ?? prev?.batteryKwh,
          1,
          1000,
          "battery (kWh)",
        ),
        maxKw: num(b.maxKw ?? prev?.maxKw, 1, 400, "max charge power (kW)"),
        driverId: prev?.driverId,
        departure: prev?.departure,
        need: prev?.need,
        socPercent: prev?.socPercent,
      };
      if (b.driverId !== undefined) {
        if (
          b.driverId &&
          !(await d.store.list("drivers")).some((x) => x.id === b.driverId)
        )
          throw new UserError("driver not found");
        v.driverId = b.driverId || undefined;
      }
      if (b.departure !== undefined) {
        const t = Date.parse(String(b.departure));
        if (b.departure && !Number.isFinite(t))
          throw new UserError("departure must be a date and time");
        v.departure = b.departure ? new Date(t).toISOString() : undefined;
      }
      if (b.needKind === "kwh")
        v.need = {
          kind: "kwh",
          kwh: num(b.needValue, 0, 1000, "energy needed (kWh)"),
        };
      else if (b.needKind === "battery")
        v.need = {
          kind: "battery",
          targetPercent: num(b.needValue, 1, 100, "target (%)"),
        };
      if (b.socPercent !== undefined)
        v.socPercent = num(b.socPercent, 0, 100, "state of charge (%)");
      await d.store.put("vehicles", v.id, v);
      await logEvent(d, prev ? "vehicle.updated" : "vehicle.created", v.name);
      await replan(d);
      return json(v);
    });
  } catch (e) {
    return fail(e);
  }
}
