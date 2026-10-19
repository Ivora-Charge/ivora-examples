import { randomUUID } from "node:crypto";
import { getDepot, logEvent } from "@/lib/depot";
import { fail, json } from "@/lib/http";
import { ivora } from "@/lib/ivora";
import { parseRfidCsv } from "@/lib/rfid";
import type { Driver } from "@/lib/types";

/** actions: create {name, idTag?}, import {csv}, block {id} */
export async function POST(req: Request) {
  try {
    const d = await getDepot();
    const b = (await req.json()) as {
      action: string;
      name?: string;
      idTag?: string;
      csv?: string;
      id?: string;
    };
    const register = async (drv: Driver) => {
      if (drv.idTag && !d.demo)
        await ivora.createToken(drv.idTag, drv.name, `token-${drv.idTag}`);
      await d.store.put("drivers", drv.id, drv);
    };
    if (b.action === "create") {
      if (!b.name) return json({ error: "name is required" }, 400);
      const drv: Driver = {
        id: randomUUID(),
        name: b.name,
        idTag: b.idTag,
        cardBlocked: false,
      };
      await register(drv);
      return json(drv);
    }
    if (b.action === "import") {
      const { rows, errors } = parseRfidCsv(b.csv ?? "");
      for (const r of rows)
        await register({
          id: randomUUID(),
          name: r.driverName,
          email: r.email,
          idTag: r.idTag,
          cardBlocked: false,
        });
      await logEvent(
        d,
        "cards.imported",
        `${rows.length} imported, ${errors.length} rejected`,
      );
      return json({ imported: rows.length, errors });
    }
    if (b.action === "block") {
      const drv = (await d.store.list("drivers")).find((x) => x.id === b.id);
      if (!drv) return json({ error: "driver not found" }, 404);
      if (drv.idTag && !d.demo) await ivora.blockToken(drv.idTag);
      drv.cardBlocked = true;
      await d.store.put("drivers", drv.id, drv);
      await logEvent(d, "card.blocked", drv.name);
      return json(drv);
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return fail(e, 502);
  }
}
