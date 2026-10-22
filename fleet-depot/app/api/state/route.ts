import { guard } from "@/lib/auth";
import { boardState, getDepot, withLock, type Depot } from "@/lib/depot";
import {
  advanceDemo,
  demoState,
  nightWindow,
  peaks,
  planOf,
  resetDemo,
  setSpeed,
  tickDemo,
} from "@/lib/demo";
import { body, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

/** A fixed chart height for the whole night: room for every vehicle on its charger at once. */
function axisMax(capKw: number, ids: string[]) {
  const all = ids.reduce((a, id) => a + (planOf(id)?.ratedKw ?? 0), 0);
  return Math.ceil(Math.max(capKw, all) / 50) * 50;
}

/** The board state, plus what only the demo knows: the clock, power history and charger plan. */
async function view(d: Depot) {
  const s = await boardState(d);
  const st = demoState(d);
  if (!d.demo || !st) return s;
  const { start, end } = nightWindow(st);
  return {
    ...s,
    rows: s.rows.map((r) => ({
      ...r,
      plan: planOf(r.vehicle.id),
      departed: st.outcomes[r.vehicle.id],
    })),
    sim: {
      speed: st.speed,
      start,
      end,
      done: Date.parse(s.now) >= end - 1,
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
  const d = await getDepot();
  // At 1x or 60x the demo clock catches up with real time whenever the state is read.
  if (d.demo) await withLock(() => tickDemo(d));
  return Response.json(await view(d));
}

/** Demo only: move the simulated clock, change its speed, or start the night again. */
export async function POST(req: Request) {
  const denied = guard(req, { write: true });
  if (denied) return denied;
  try {
    const d = await getDepot();
    if (!d.demo)
      return Response.json(
        { error: "Only available in demo mode" },
        { status: 400 },
      );
    const { action, minutes, speed } = await body<{
      action: string;
      minutes: number;
      speed: number;
    }>(req);
    if (action === "advance")
      await withLock(() =>
        advanceDemo(d, Math.min(Math.max(Number(minutes) || 30, 1), 720)),
      );
    else if (action === "speed")
      await withLock(async () => setSpeed(d, Number(speed)));
    else if (action === "reset") await withLock(() => resetDemo(d));
    return Response.json(await view(d));
  } catch (e) {
    return fail(e);
  }
}
