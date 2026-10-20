import { SessionScreen } from "@/components/session-screen";
import { isDemoId } from "@/lib/demo";
import { sessionView } from "@/lib/server/driver";
import { settings } from "@/lib/server/services";

export const dynamic = "force-dynamic";

export default async function Session({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Demo sessions render immediately; live ones load in the browser so a slow API never blocks the page.
  const initial = isDemoId(id)
    ? await sessionView(id, settings()).catch(() => null)
    : null;
  return <SessionScreen id={id} initial={initial} />;
}
