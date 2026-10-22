import Link from "next/link";
import { TIME_ZONES } from "@/lib/locale-options";
import { requireRole } from "@/lib/server/auth";
import {
  defaultSimulation,
  editorValues,
  getPricing,
  newTariffDefaults,
} from "@/lib/server/pricing";
import { TariffEditor } from "../forms";

export const metadata = { title: "New tariff" };

export default async function Page() {
  const me = await requireRole("manager");
  const base = await newTariffDefaults(getPricing(), me);
  return (
    <>
      <p>
        <Link href="/pricing">← Pricing</Link>
      </p>
      <h1>New tariff</h1>
      <section className="card" aria-labelledby="editor-heading">
        <h2 id="editor-heading">Prices</h2>
        <p className="muted">
          In {base.currency}, your company currency (change it in{" "}
          <Link href="/settings">Settings</Link> before creating tariffs).
          Preview a session to see Ivora&apos;s exact price before you save.
        </p>
        <TariffEditor
          tariffId={null}
          initial={editorValues("", null, base, base.idleGrace)}
          currency={base.currency}
          timeZones={TIME_ZONES}
          simulation={defaultSimulation(base.timeZone)}
        />
      </section>
    </>
  );
}
