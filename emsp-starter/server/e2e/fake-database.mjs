// A stand-in for the database of the e2e "live" setups (playwright.config.ts), loaded
// into those servers with `node --import`. The setups name made-up hosts under
// example.org and example.net; this answers the server's requests to them in process,
// so nothing leaves the machine and no real host is ever asked. It is test support
// only: the app does not import it, and a build does not contain it.
//
// It speaks just enough of the Data API (PostgREST) for the setup status read and the
// database check: every shipped table, column and function exists, and four tables
// have rows. What they hold differs per host, on purpose:
//
// - db-one and db-two have no admin yet. Their facts differ (other peers, other
//   times, a refused webhook request on one), but the same stops pass and fail, so a
//   visitor must be sent the same bytes by both.
// - db-three has an admin: a visitor gets the sign-in prompt alone.
const ago = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();
const peer = (n, status = "registered") => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  label: `Example CPO ${n}`,
  direction: "outbound",
  status,
  versions_url: `https://cpo-${n}.example.com/ocpi/versions`,
  version: "2.2.1",
  roles: [{ role: "CPO", country_code: "NL", party_id: `EX${n}` }],
  endpoints: [],
  hub_parties: [],
  hub_push_mode: "per_party",
  token_ciphertext: null,
  rev: 1,
  created_at: ago(86_400 * n),
  updated_at: ago(3_600 * n),
  registered_at: status === "registered" ? ago(3_600 * n) : null,
  unregistered_at: null,
});
const audit = (action, seconds, details = {}) => ({
  occurred_at: ago(seconds),
  actor: "e2e",
  action,
  subject_id: action === "job.run" ? "setup:job" : "setup:stripe-webhook",
  request_id: null,
  details,
});

const DATABASES = {
  // Payments and the job are set on this server, but no signed event has arrived
  // and the job has never run.
  "db-one.example.org": () => ({
    admins: 0,
    peers: [peer(1), peer(2)],
    events: [],
    sweeps: [],
    audit: [audit("webhook.refused", 30)],
  }),
  // Events and job runs are in the database, but this server has neither secret set.
  "db-two.example.net": () => ({
    admins: 0,
    peers: [peer(3), peer(4), peer(5), peer(6), peer(7, "pending")],
    events: [{ type: "payment_intent.succeeded", received_at: ago(259_200) }],
    sweeps: [{ swept_at: ago(20) }],
    audit: [
      audit("job.run", 600, { ok: true, since_last_s: 60 }),
      audit("job.run", 4_200, { ok: true, since_last_s: 61 }),
    ],
  }),
  "db-three.example.org": () => ({
    admins: 1,
    peers: [peer(8)],
    events: [{ type: "charge.refunded", received_at: ago(90) }],
    sweeps: [{ swept_at: ago(15) }],
    audit: [audit("job.run", 300, { ok: true, since_last_s: 60 })],
  }),
};

function answer(url) {
  const state = DATABASES[url.hostname]();
  const table = url.pathname.replace(/^\/rest\/v1\//, "");
  const limit = Number(url.searchParams.get("limit") ?? "1000");
  const rows = (() => {
    if (table === "emsp_admins")
      return Array.from({ length: state.admins }, () => ({ role: "admin" }));
    if (table === "emsp_ocpi_peers") return state.peers;
    if (table === "emsp_stripe_events") return state.events;
    if (table === "emsp_payment_sweeps") return state.sweeps;
    if (table === "emsp_audit_log") {
      const subject = url.searchParams.get("subject_id")?.replace(/^eq\./, "");
      return state.audit.filter((row) => row.subject_id === subject);
    }
    // Any other table, and every function: there, and empty.
    return [];
  })();
  return Response.json(rows.slice(0, limit));
}

const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  if (url.hostname in DATABASES) return answer(url);
  // The run is offline: a request to any other made-up host fails like a dead one.
  if (/\.example\.(org|net|com)$/.test(url.hostname))
    throw new TypeError("fetch failed");
  return real(input, init);
};
