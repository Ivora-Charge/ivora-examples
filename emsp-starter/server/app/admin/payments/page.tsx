import type { Metadata } from "next";
import { config } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { isDriverReference } from "../drivers/reference";
import { forEmailAdmin } from "../ui/for-admin";
import { Head } from "../ui/kit";
import { Gated } from "../ui/parts";
import { PaymentAdmin } from "./payment-admin";

export const metadata: Metadata = { title: "Payments" };

const ID = /^[0-9a-f-]{36}$/i;

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{
    find?: string | string[];
    driver?: string | string[];
  }>;
}) {
  // A link from another page names the payment (a flagged one on Reconciliation) or
  // the driver (a driver's page).
  const { find, driver } = await searchParams;
  // Whether the key is set, never the key; and only for an admin signed in by email.
  const stripeSet = await forEmailAdmin(() => Boolean(config.stripeSecretKey));
  return (
    <>
      <Head
        crumbs={["Money"]}
        title="Payments"
        lead="A card hold before every app start, captured from the session's CDR and never above the hold. What the rules cannot settle waits here for a person, and is never charged automatically."
      />
      <Gated what="see payments">
        <PaymentAdmin
          demo={isDemo()}
          stripeSet={stripeSet}
          find={typeof find === "string" && ID.test(find) ? find : undefined}
          driver={isDriverReference(driver) ? driver : undefined}
        />
      </Gated>
    </>
  );
}
