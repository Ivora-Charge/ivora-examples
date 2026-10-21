import { cookies } from "next/headers";
import { SESSION_COOKIE, authorized, gate } from "@/lib/server/auth";
import { isDemo } from "@/lib/server/config";
import { resolveQrBase } from "@/lib/urls";
import { brand } from "../../../brand/brand";
import DemoBanner from "../demo-banner";
import Login from "../login";
import Wizard from "../wizard";

export const metadata = { title: `Commission a charger | ${brand.name}` };

export default async function Page() {
  const demo = isDemo();
  const g = gate();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const qr = resolveQrBase({ demo, requestOrigin: "http://localhost" });
  return (
    <main id="main">
      {demo && <DemoBanner />}
      <h1>Commission a charger</h1>
      <p className="lead">{brand.lead}</p>
      {g.mode === "missing" ? (
        <section>
          <h2>Setup needed</h2>
          <p role="alert" className="error">
            {g.reason} Live mode stays off until it is set; see the README.
          </p>
        </section>
      ) : authorized(token) ? (
        <Wizard demo={demo} qrProblem={qr.ok ? null : qr.reason} />
      ) : (
        <Login />
      )}
    </main>
  );
}
