import { guard } from "@/lib/auth";
import { getDepot, withLock } from "@/lib/depot";
import { blockDriver, createDriver, importDrivers } from "@/lib/drivers";
import { body, fail, json } from "@/lib/http";

/** actions: create {name, idTag?}, import {csv}, block {id} */
export async function POST(req: Request) {
  const denied = guard(req, { write: true });
  if (denied) return denied;
  try {
    const d = await getDepot();
    const b = await body<{
      action: string;
      name: string;
      idTag: string;
      csv: string;
      id: string;
    }>(req);
    return await withLock(async () => {
      if (b.action === "create")
        return json(
          await createDriver(d, { name: String(b.name ?? ""), idTag: b.idTag }),
        );
      if (b.action === "import") {
        const csv = String(b.csv ?? "");
        if (csv.length > 1_000_000)
          return json({ error: "CSV too large" }, 413);
        return json(await importDrivers(d, csv));
      }
      if (b.action === "block") {
        const drv = await blockDriver(d, String(b.id ?? ""));
        return json({ id: drv.id, cardBlocked: drv.cardBlocked });
      }
      return json({ error: "unknown action" }, 400);
    });
  } catch (e) {
    return fail(e);
  }
}
