import { checkRole, currentStaff } from "@/lib/server/auth";
import { getLive } from "@/lib/server/live";

export const dynamic = "force-dynamic";

/**
 * What open Live pages poll every few seconds: a version that changes when an Ivora
 * webhook arrives or a command changes. It reads the kit's own database only, never
 * the Ivora API, so polling it costs no API requests; a page re-reads the API only
 * when the version moves.
 */
export async function GET() {
  let staff;
  try {
    staff = checkRole(await currentStaff(), "viewer");
  } catch {
    staff = null;
  }
  if (!staff)
    return Response.json(
      { error: "sign in" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  try {
    const version = await getLive().store.version(staff.operatorId);
    return Response.json(
      { version },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (e) {
    console.error("cpo-starter-kit: live changes failed:", {
      error: e instanceof Error ? e.name : "error",
    });
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}
