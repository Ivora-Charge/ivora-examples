import { getDepot, replan } from "@/lib/depot";
import { fail, json } from "@/lib/http";
import type { Vehicle } from "@/lib/types";

export async function POST(req: Request) {
  try {
    const d = await getDepot();
    const b = (await req.json()) as Partial<Vehicle> & { name: string };
    if (!b.name || !((b.batteryKwh ?? 0) > 0) || !((b.maxKw ?? 0) > 0))
      return json({ error: "name, batteryKwh and maxKw are required" }, 400);
    const id = b.id ?? crypto.randomUUID();
    const v: Vehicle = { kind: "van", plate: "", ...b, id } as Vehicle;
    await d.store.put("vehicles", id, v);
    await replan(d);
    return json(v);
  } catch (e) {
    return fail(e);
  }
}
