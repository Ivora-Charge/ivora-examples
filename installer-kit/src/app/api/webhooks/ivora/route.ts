import { NextResponse } from "next/server";
import { db } from "@/lib/store";
import { mapEvent } from "@/lib/status";
import { verifySignature } from "@/lib/webhook";

export async function POST(req: Request) {
  const body = await req.text();
  const sig = req.headers.get("x-ivora-signature");
  if (!verifySignature(body, sig, process.env.IVORA_WEBHOOK_SECRET ?? "")) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }
  const evt = JSON.parse(body) as {
    type: string;
    stationId?: string;
    data?: Record<string, unknown>;
  };
  const c = evt.stationId ? db().chargers.get(evt.stationId) : undefined;
  const state = mapEvent(evt.type);
  if (c && state) c.state = state;
  return NextResponse.json({ ok: true });
}
