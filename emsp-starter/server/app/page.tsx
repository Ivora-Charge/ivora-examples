import { configErrors, missingForLive } from "@/lib/server/config";
import { getStatus } from "@/lib/server/status";

const COMING = [
  "CPO peers and OCPI credentials",
  "Locations and tariffs",
  "Drivers and tokens",
  "Sessions and CDRs",
  "Payments",
];

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
      <section className="card" aria-labelledby="coming">
        <h2 id="coming">Coming soon</h2>
        <ul>
          {COMING.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </section>
    </>
  );
}
