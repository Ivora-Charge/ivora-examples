import Link from "next/link";
import { configErrors, missingForLive } from "@/lib/server/config";
import { getStatus } from "@/lib/server/status";

const ADMIN_PAGES = [
  [
    "/admin/sessions",
    "Sessions",
    "live and recent, by peer, status and driver",
  ],
  ["/admin/payments", "Payments and refunds", "review, refunds and audit log"],
  [
    "/admin/reconciliation",
    "CDR reconciliation",
    "sessions vs CDRs vs captured amounts, per peer, with a CSV",
  ],
  ["/admin/tokens", "Drivers and tokens", "block and unblock, RFID cards"],
  ["/admin/problems", "Reported problems", "what drivers report from the app"],
] as const;

export default function Overview() {
  const status = getStatus();
  // Variable names only, never values.
  const missing = missingForLive();
  const errors = configErrors();
  return (
    <>
      <h1>Overview</h1>
      <section className="card" aria-labelledby="identity">
        <h2 id="identity">OCPI identity</h2>
        <dl className="facts">
          <dt>Mode</dt>
          <dd>{status.mode === "demo" ? "Demo" : "Live"}</dd>
          <dt>OCPI version</dt>
          <dd>{status.ocpi.version}</dd>
          <dt>Role</dt>
          <dd>eMSP</dd>
          <dt>Country code</dt>
          <dd>
            <code>{status.ocpi.country_code}</code>
          </dd>
          <dt>Party ID</dt>
          <dd>
            <code>{status.ocpi.party_id}</code>
          </dd>
        </dl>
        {status.mode === "demo" &&
          (missing.length > 0 || errors.length > 0) && (
            <div className="note">
              {missing.length > 0 && (
                <p>
                  Live mode needs:{" "}
                  {missing.map((name, i) => (
                    <span key={name}>
                      {i > 0 && ", "}
                      <code>{name}</code>
                    </span>
                  ))}
                  . See the README.
                </p>
              )}
              {errors.map((e) => (
                <p key={e}>{e}</p>
              ))}
            </div>
          )}
      </section>
      <section className="card" aria-labelledby="peers">
        <h2 id="peers">CPO peers</h2>
        <p>
          Connect to CPOs over the OCPI credentials module:{" "}
          <Link href="/admin/peers">manage CPO peers</Link>.
        </p>
      </section>
      <section className="card" aria-labelledby="admin">
        <h2 id="admin">Admin</h2>
        <ul>
          {ADMIN_PAGES.map(([href, name, what]) => (
            <li key={href}>
              <Link href={href}>{name}</Link>: {what}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
