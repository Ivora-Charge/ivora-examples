import { cookies } from "next/headers";
import { SESSION_COOKIE, authorized, gate } from "@/lib/server/auth";
import { isDemo } from "@/lib/server/config";
import { resolveQrBase } from "@/lib/urls";
import { brand } from "../../brand/brand";
import Login from "./login";
import Wizard from "./wizard";

export default async function Page() {
  const demo = isDemo();
  const g = gate();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const qr = resolveQrBase({ demo, requestOrigin: "http://localhost" });
  return (
    <main id="main">
      {demo && (
        <p className="banner">
          DEMO MODE: simulated charger and sample data. No charger commands,
          payments or other requests are sent anywhere.
        </p>
      )}
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
