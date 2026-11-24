import type { Metadata } from "next";
import { config } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { Head } from "../ui/kit";
import { Gated } from "../ui/parts";
import { PaymentAdmin } from "./payment-admin";

export const metadata: Metadata = { title: "Payments" };

const ID = /^[0-9a-f-]{36}$/i;

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ find?: string | string[] }>;
}) {
  // A link from another page (a flagged payment on Reconciliation) names the payment.
  const { find } = await searchParams;
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
          // Whether the key is set, never the key.
          stripeSet={Boolean(config.stripeSecretKey)}
          find={typeof find === "string" && ID.test(find) ? find : undefined}
        />
      </Gated>
    </>
  );
}
