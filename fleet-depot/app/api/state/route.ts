import { boardState, getDepot } from "@/lib/depot";
import { advanceDemo } from "@/lib/demo";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await boardState(await getDepot()));
}

export async function POST(req: Request) {
  const d = await getDepot();
  const { action, minutes } = (await req.json().catch(() => ({}))) as {
    action?: string;
    minutes?: number;
  };
  if (!d.demo)
    return Response.json(
      { error: "Only available in demo mode" },
      { status: 400 },
    );
  if (action === "advance")
    await advanceDemo(d, Math.min(Math.max(Number(minutes) || 30, 1), 720));
  return Response.json(await boardState(d));
}
