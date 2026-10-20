import { guard } from "@/lib/auth";
import { boardState, getDepot, withLock } from "@/lib/depot";
import { advanceDemo } from "@/lib/demo";
import { body, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = guard(req, { write: false });
  if (denied) return denied;
  return Response.json(await boardState(await getDepot()));
}

/** Demo only: advance the simulated clock. */
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
    const { action, minutes } = await body<{ action: string; minutes: number }>(
      req,
    );
    if (action === "advance")
      await withLock(() =>
        advanceDemo(d, Math.min(Math.max(Number(minutes) || 30, 1), 720)),
      );
    return Response.json(await boardState(d));
  } catch (e) {
    return fail(e);
  }
}
