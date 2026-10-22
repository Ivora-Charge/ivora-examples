import { guard } from "@/lib/auth";
import { boardState, withLock, type Depot } from "@/lib/depot";
import {
  DEMO_TZ,
  demoState,
  nightWindow,
  peaks,
  planOf,
  snap,
} from "@/lib/demo";
import {
  SPEEDS,
  anchorCookie,
  depotFor,
  depotOf,
  freshAnchor,
  keepAnchor,
  nightOver,
  simTime,
  type Anchor,
  type Speed,
} from "@/lib/demo-visitor";
import { body, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

/** A fixed chart height for the whole night: room for every vehicle on its charger at once. */
function axisMax(capKw: number, ids: string[]) {
  const all = ids.reduce((a, id) => a + (planOf(id)?.ratedKw ?? 0), 0);
  return Math.ceil(Math.max(capKw, all) / 50) * 50;
}

/** The board state, plus what only the demo knows: the clock, power history and charger plan. */
async function view(d: Depot, a?: Anchor) {
  const s = await boardState(d);
  const st = demoState(d);
  if (!d.demo || !st || !a) return s;
  const { start, end } = nightWindow(st);
  const at = Date.now();
  const done = nightOver(a, at);
  return {
    ...s,
    tz: DEMO_TZ,
    rows: s.rows.map((r) => ({
      ...r,
      plan: planOf(r.vehicle.id),
      departed: st.outcomes[r.vehicle.id],
      notArrived: Date.parse(s.now) < (st.arrivals[r.vehicle.id] ?? 0),
    })),
    sim: {
      speed: done ? 0 : a.speed,
      // The board moves in 5-minute steps; the clock shows the minute.
      at: Math.floor(simTime(a, at) / 60_000) * 60_000,
      start,
      end,
      done,
      ...peaks(st),
      axisMaxKw: axisMax(
        s.settings.siteCapKw,
        s.rows.map((r) => r.vehicle.id),
      ),
      samples: st.samples.map((x) => [
        x.t,
        Math.round(x.kw * 10) / 10,
        x.ghostKw,
      ]),
    },
  };
}

export async function GET(req: Request) {
  const denied = guard(req, { write: false });
  if (denied) return denied;
  // Demo: the visitor's own night, caught up with real time from their cookie.
  const v = await depotOf(req);
  return keepAnchor(Response.json(await view(v.d, v.anchor)), v);
}

const MAX_ADVANCE_MIN = 720;

/** Demo only: move the visitor's simulated clock, change its speed, or start the night again. */
export async function POST(req: Request) {
  const denied = guard(req, { write: true });
  if (denied) return denied;
  try {
    const v = await depotOf(req);
    if (!v.d.demo || !v.anchor)
      return Response.json(
        { error: "Only available in demo mode" },
        { status: 400 },
      );
    const { action, minutes, speed } = await body<{
      action: string;
      minutes: number;
      speed: number;
    }>(req);
    const now = Date.now();
    const cur = simTime(v.anchor, now);
    let next: Anchor = v.anchor;
    if (action === "advance") {
      const m = Math.min(Math.max(Number(minutes) || 30, 1), MAX_ADVANCE_MIN);
      next = { ...v.anchor, simAt: snap(cur) + m * 60_000, realAt: now };
    } else if (action === "speed") {
      const sp = Number(speed) as Speed;
      next = {
        ...v.anchor,
        simAt: cur,
        realAt: now,
        speed: SPEEDS.includes(sp) ? sp : 0,
      };
    } else if (action === "reset") next = freshAnchor(now);
    else return Response.json({ error: "unknown action" }, { status: 400 });
    // Keep the anchor inside the night (simTime clamps it the same way).
    next.simAt = simTime({ ...next, realAt: now, speed: 0 }, now);
    const d = await withLock(() => depotFor(next, now));
    const res = Response.json(await view(d, next));
    res.headers.append("set-cookie", anchorCookie(next));
    return res;
  } catch (e) {
    return fail(e);
  }
}
