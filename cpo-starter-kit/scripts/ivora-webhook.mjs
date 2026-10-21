// Registers and inspects this deployment's Ivora webhook endpoint, like Squid's
// `ivora:webhook`. Reads IVORA_API_KEY, IVORA_TENANT_ID (and optionally
// IVORA_API_BASE_URL, APP_URL) from .env.local. Never prints the API key.
//
//   npm run ivora:webhook -- register [https://<your domain>/api/webhooks/ivora]
//   npm run ivora:webhook -- list | test <id> | deliveries <id> | disable <id>
import { createHash } from "node:crypto";

// Keep in step with WEBHOOK_EVENTS in lib/server/live/service.ts.
export const EVENTS = [
  "station.connected",
  "station.disconnected",
  "station.booted",
  "connector.status_changed",
  "station.fault_opened",
  "station.fault_cleared",
  "charging_session.status_changed",
  "operation.completed",
];
export const PATH = "/api/webhooks/ivora";

const env = (name) => process.env[name]?.trim() || "";

/** The endpoint URL: public https on port 443, ending in the kit's webhook path. */
export function endpointUrl(argument, appUrl) {
  const url =
    argument || (appUrl ? `${appUrl.replace(/\/+$/, "")}${PATH}` : "");
  try {
    const u = new URL(url);
    if (
      u.protocol === "https:" &&
      !u.port &&
      !u.username &&
      !u.password &&
      !u.search &&
      u.pathname === PATH &&
      u.hostname !== "localhost" &&
      !/^[\d.]+$|:/.test(u.hostname)
    )
      return u.toString();
  } catch {
    // Not a URL: fall through.
  }
  return null;
}

/**
 * The Idempotency-Key of a registration, derived from what it registers and how many
 * endpoints for that URL exist already: a retry after a lost response reuses it, and
 * registering again after disabling the old endpoint gets a new one.
 */
export function registrationKey(url, existing) {
  const h = createHash("sha256")
    .update(`${url}\n${EVENTS.join(",")}`)
    .digest("hex")
    .slice(0, 24);
  return `cpo-webhook-${h}-create-${existing + 1}`;
}

async function main() {
  const [command = "help", argument] = process.argv.slice(2);
  const base = (
    env("IVORA_API_BASE_URL") || "https://api.ivoracharge.com"
  ).replace(/\/+$/, "");
  const tenant = env("IVORA_TENANT_ID");
  const key = env("IVORA_API_KEY");
  if (!tenant || !key || !/^\d+$/.test(tenant)) {
    console.error(
      "Set IVORA_API_KEY and IVORA_TENANT_ID (numeric) in .env.local first.",
    );
    process.exit(1);
  }

  async function call(path, init = {}) {
    const response = await fetch(`${base}/v1/tenants/${tenant}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${key}`,
        accept: "application/json",
        "content-type": "application/json",
        ...(init.headers || {}),
      },
      redirect: "error",
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const id = body?.request_id ? ` (request ${body.request_id})` : "";
      console.error(
        `Ivora ${response.status}: ${body?.error?.code ?? ""} ${body?.error?.message ?? ""}${id}`.trim(),
      );
      process.exit(1);
    }
    return body;
  }
  const rows = (list) => (Array.isArray(list) ? list : (list?.data ?? []));

  if (command === "register") {
    const url = endpointUrl(argument, env("APP_URL"));
    if (!url) {
      console.error(
        `Ivora delivers only to public https URLs on port 443. Pass the deployed URL, for example:\n  npm run ivora:webhook -- register https://ops.example.com${PATH}`,
      );
      process.exit(1);
    }
    const hooks = rows(await call("/webhooks")).filter((h) => h.url === url);
    const active = hooks.find((h) => h.status === "active");
    if (active) {
      console.error(
        `An active endpoint for ${url} exists already: ${active.id}.\nIvora shows its secret only once. If you have it, keep using it. Otherwise disable it and register again:\n  npm run ivora:webhook -- disable ${active.id}`,
      );
      process.exit(1);
    }
    const hook = await call("/webhooks", {
      method: "POST",
      headers: { "idempotency-key": registrationKey(url, hooks.length) },
      body: JSON.stringify({
        url,
        events: EVENTS,
        description: "CPO Starter Kit live view",
      }),
    });
    console.log(`Registered webhook ${hook.id} for ${hook.url}.`);
    console.log(
      `\nAdd this to the deployment's environment variables, then redeploy. Ivora shows it only once:\n\nIVORA_WEBHOOK_SECRET=${hook.secret}\n`,
    );
    console.log(
      `After deploying, check signature handling with:\n  npm run ivora:webhook -- test ${hook.id}\n  npm run ivora:webhook -- deliveries ${hook.id}`,
    );
  } else if (command === "list") {
    for (const h of rows(await call("/webhooks")))
      console.log(h.id, h.status, h.url, (h.events || []).join(","));
  } else if (command === "test" && argument) {
    const r = await call(`/webhooks/${encodeURIComponent(argument)}/test`, {
      method: "POST",
    });
    console.log(`Test delivery queued${r?.id ? ` (${r.id})` : ""}.`);
  } else if (command === "deliveries" && argument) {
    for (const d of rows(
      await call(
        `/webhooks/${encodeURIComponent(argument)}/deliveries?limit=20`,
      ),
    ))
      console.log(
        d.created_at,
        d.event_type,
        d.status,
        `attempts=${d.attempts}`,
        d.last_status ?? "",
        d.last_error ?? "",
      );
  } else if (command === "disable" && argument) {
    await call(`/webhooks/${encodeURIComponent(argument)}`, {
      method: "DELETE",
    });
    console.log(`Disabled ${argument}.`);
  } else {
    console.error(
      `Usage: npm run ivora:webhook -- register [https://<domain>${PATH}] | list | test <id> | deliveries <id> | disable <id>`,
    );
    process.exit(1);
  }
}

// Run only as a script (tests import the helpers above).
if (import.meta.url === `file://${process.argv[1]}`) await main();
