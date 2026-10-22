import type { Metadata } from "next";
import { config } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { PaymentAdmin } from "./payment-admin";

export const metadata: Metadata = { title: "Payments" };

export default function PaymentsPage() {
  const demo = isDemo();
  return (
    <>
      <h1>Payments</h1>
      <section className="card" aria-labelledby="about">
        <h2 id="about">How drivers pay</h2>
        <p>
          Before every app start, the driver&apos;s saved card is held for a set
          amount. The session&apos;s CDR then captures its total incl. VAT,
          never more than the hold. Anything the rules cannot settle (a CDR
          above the hold, a hold that expired, another currency) waits here for
          a person, and is never charged automatically.
        </p>
        {demo ? (
          <p className="note">
            Demo mode: no card is charged and nothing is sent to Stripe.
          </p>
        ) : (
          !config.stripeSecretKey && (
            <p className="note">
              Payments are not set up: set <code>STRIPE_SECRET_KEY</code>. Until
              then every app start is refused.
            </p>
          )
        )}
      </section>
      <PaymentAdmin />
    </>
  );
}
