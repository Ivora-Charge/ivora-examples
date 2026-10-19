import { NextResponse } from "next/server";
import { createSite } from "@/lib/service";
import { db } from "@/lib/store";
import { fail } from "@/lib/http";

export const GET = () => NextResponse.json([...db().sites.values()]);

export async function POST(req: Request) {
  try {
    const { name, address } = await req.json();
    if (!name || !address) throw new Error("name and address are required");
    return NextResponse.json(createSite(String(name), String(address)));
  } catch (e) {
    return fail(e);
  }
}
