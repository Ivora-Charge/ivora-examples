import type { Metadata } from "next";
import Link from "next/link";
import { adminEnabled } from "@/lib/server/admin";
import { ocpiUrls } from "@/lib/server/config";
import { isDemo } from "@/lib/server/demo";
import { DEMO_DRIVER_REF } from "@/lib/tokens/registry";
import { TokenAdmin } from "./token-admin";

export const metadata: Metadata = { title: "Driver tokens" };

export default function TokensPage() {
  return (
    <>
      <h1>Driver tokens</h1>
      <section className="card" aria-labelledby="about">
        <h2 id="about">Who can charge</h2>
        <p>
          Each driver has an app token with a contract ID, and may have RFID
          cards on the same contract. Every change is pushed to each CPO at
          once; CPOs can also pull every token from{" "}
          <code className="wrap">{ocpiUrls().tokens}</code> and ask us in real
          time before a driver charges.
        </p>
        {isDemo() && (
          <p className="note">
            Demo mode: tokens are kept in memory only and nothing is pushed to a
            CPO. Look up the sample driver <code>{DEMO_DRIVER_REF}</code>.
          </p>
        )}
        <p className="note">
          Admin actions need an admin signed in (
          <Link href="/admin/sign-in">sign in</Link>)
          {adminEnabled() ? ", or the server's ADMIN_SECRET." : "."}
        </p>
        <p className="note">
          Drivers get their app token at their first sign-in in the app. Use
          this page for RFID cards, blocks and support.
        </p>
      </section>
      <TokenAdmin />
    </>
  );
}
