import { notFound } from "next/navigation";
import { formatMinor } from "@/lib/money";
import { getCheckout } from "@/lib/server/checkout";
import { config, isDemo } from "@/lib/server/env";
import { demoPayment } from "@/lib/server/ivora/demo";
import { cookieDemoFleet } from "@/lib/server/ivora/demo-cookie";
import { demoPayAction } from "../../actions";

export const metadata = { title: "Demo checkout" };

/**
 * Demo mode only: stands in for Stripe Checkout, where a real driver enters their card
 * on a page run by Ivora and Stripe. No card is asked for and nothing is charged.
 */
export default async function Page({
  params,
}: {
  params: Promise<{ payment: string }>;
}) {
  if (!isDemo()) notFound();
  const { payment } = await params;
  const p = await demoPayment(cookieDemoFleet(), payment);
  if (!p) notFound();
  const rec = await getCheckout().store.getByReference(p.returnReference);
  const hold = formatMinor(p.holdMinor, p.currency);
  return (
    <section className="card stack" aria-labelledby="pay-heading">
      <p className="notice" role="note">
        Demo checkout: this page stands in for Stripe Checkout. No card is
        needed and nothing is charged.
      </p>
      <h1 id="pay-heading">Pay {config.operatorName}</h1>
      <p>
        Card hold: <strong>{hold}</strong>. You pay for your session; the rest
        is released.
      </p>
      <div className="field">
        <label htmlFor="demo-card">Card number</label>
        <input id="demo-card" value="Demo card, nothing is charged" readOnly />
      </div>
      {p.released && !p.authorized ? (
        <p className="error" role="alert">
          This payment page has expired. Nothing was charged.
        </p>
      ) : p.authorized ? (
        <p className="success" role="status">
          Already paid.{" "}
          {rec && <a href={`/c/${rec.stickerCode}`}>Follow your session</a>}
        </p>
      ) : (
        <form action={demoPayAction}>
          <input type="hidden" name="payment" value={payment} />
          <button type="submit" className="button block">
            Pay with demo card ({hold} hold)
          </button>
        </form>
      )}
      {rec && (
        <p>
          <a href={`/c/${rec.stickerCode}`}>Cancel and go back</a>
        </p>
      )}
    </section>
  );
}
