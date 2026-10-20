import { NextResponse } from "next/server";
import { body, guarded } from "@/lib/server/route";
import { createSite, listSites, pickLocation } from "@/lib/server/service";

export const GET = guarded({ write: false }, async () =>
  NextResponse.json(await listSites()),
);

/** Create a new site (and Ivora location), or pick an existing location. */
export const POST = guarded({ write: true }, async (req) => {
  const input = await body(req);
  const site =
    typeof input.locationId === "string"
      ? await pickLocation(input.locationId)
      : await createSite(input);
  return NextResponse.json(site);
});
