import { brand } from "../../../brand/brand";
import { CashierConsole } from "@/components/cashier-console";
import { DEMO_SITE_NAME } from "@/lib/demo";
import { requireCashier } from "@/lib/server/operator-page";

export const dynamic = "force-dynamic";

export const metadata = { title: `Cashier console · ${brand.name}` };

/** Tablet-first console at the counter: every charger like a fuel pump. */
export default async function Cashier() {
  const s = await requireCashier();
  return (
    <main className="console">
      <nav className="operator">
        <strong>
          {s.demo ? DEMO_SITE_NAME : process.env.SITE_NAME || "Cashier"}
        </strong>
        <span className="muted">Cashier console</span>
        <form action="/api/cashier/logout" method="post">
          <button className="secondary" type="submit">
            Sign out
          </button>
        </form>
      </nav>
      {s.demo ? (
        <p className="notice">
          Demo forecourt: sample chargers in every state, kept in this browser
          only. Open a charger&apos;s{" "}
          <a href="/c/DEMO-4/1/counter" target="_blank">
            pay-at-the-counter screen
          </a>{" "}
          in another tab to see what the driver sees. The simulated POS below
          the chargers shows the signed <code>session_due</code> webhooks a
          store POS would receive, and pays through the POS API.
        </p>
      ) : null}
      <CashierConsole initial={null} />
      <p className="muted">
        Payments taken here are collected on the store&apos;s own POS and
        recorded in Ivora as paid in store. They never go through Stripe.
      </p>
    </main>
  );
}
