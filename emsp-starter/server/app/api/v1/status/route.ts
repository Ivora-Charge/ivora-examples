import { publicStatus } from "@/lib/server/status";

// Mode comes from the server environment at request time, and "live" also from the
// database check (remembered for a while: lib/setup/database.ts).
export const dynamic = "force-dynamic";

// Public and credential-free, so any origin may read it (the app's web build is
// usually served from another origin). Endpoints with driver data get their own,
// stricter CORS rules.
const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};

export async function GET() {
  return Response.json(await publicStatus(), { headers: HEADERS });
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: { ...HEADERS, "Access-Control-Allow-Methods": "GET, OPTIONS" },
  });
}
