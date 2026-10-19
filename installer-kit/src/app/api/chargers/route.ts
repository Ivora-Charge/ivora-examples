import { NextResponse } from "next/server";
import { addCharger } from "@/lib/service";
import { fail } from "@/lib/http";
import { ocppConnectionUrl } from "@/lib/urls";
import { qrSvg } from "@/lib/qr";

export async function POST(req: Request) {
  try {
    const { siteId, name } = await req.json();
    if (!siteId || !name) throw new Error("siteId and name are required");
    const { charger, credentials, endpoint } = await addCharger(
      String(siteId),
      String(name),
    );
    const url = ocppConnectionUrl(endpoint, charger.id);
    return NextResponse.json({
      charger,
      url,
      password: credentials.password,
      qr: await qrSvg(url),
    });
  } catch (e) {
    return fail(e);
  }
}
