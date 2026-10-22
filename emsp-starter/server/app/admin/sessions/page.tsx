import type { Metadata } from "next";
import Link from "next/link";
import { DEMO_PEER_ID } from "@/lib/locations/registry";
import { adminEnabled } from "@/lib/server/admin";
import { isDemo } from "@/lib/server/demo";
import { SessionAdmin } from "./session-admin";

export const metadata: Metadata = { title: "Sessions" };

export default function SessionsPage() {
  return (
    <>
      <h1>Sessions</h1>
      <section className="card" aria-labelledby="about">
        <h2 id="about">What drivers charge</h2>
        <p>
          Every session a CPO pushed to us or we pulled from it, as the CPO last
          described it. The charge ID is the payment&apos;s: look it up on{" "}
          <Link href="/admin/payments">Payments and refunds</Link>. Peer IDs are
          in the peer list on <Link href="/admin/peers">CPO peers</Link>.
        </p>
        {isDemo() && (
          <p className="note">
            Demo mode: the sessions are the mock CPO&apos;s samples, kept in
            memory. Its peer ID is <code>{DEMO_PEER_ID}</code>.
          </p>
        )}
        <p className="note">
          Lists need an admin signed in (
          <Link href="/admin/sign-in">sign in</Link>)
          {adminEnabled() ? ", or the server's ADMIN_SECRET." : "."}
        </p>
      </section>
      <SessionAdmin />
    </>
  );
}
