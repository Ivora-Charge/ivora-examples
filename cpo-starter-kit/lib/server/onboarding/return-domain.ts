import "server-only";
import { atLeast } from "@/lib/roles";
import { describeError, idempotencyKey, IvoraError } from "../ivora";
import type { IvoraClient, ReturnDomain } from "../ivora";
import { returnTxtRecord } from "../checkout/return-url";
import type { QrBase } from "../qr-base";
import type { Staff } from "../team/types";
import { notAllowed } from "./types";

// Onboarding's "Return domain" step: registers the kit's public hostname with Ivora
// (`POST /return-domains`), shows the TXT record to publish, and checks it
// (`POST /return-domains/{id}/verify`). Until it is verified, drivers come back to
// Ivora's driver page as before. Listing needs `stations:read`, registering and
// verifying `stations:write`: scopes the kit's key already has for Onboarding.

export type ReturnDomainState =
  /** Demo mode: a sample, nothing is sent. */
  | "demo"
  /** PUBLIC_BASE_URL (or APP_URL) isn't a stable https hostname of your own. */
  | "no_origin"
  | "not_registered"
  | "pending"
  | "ready";

export interface ReturnDomainView {
  state: ReturnDomainState;
  hostname: string | null;
  id: string | null;
  /** The TXT record to publish, once Ivora has issued its token. */
  txt: { name: string; value: string } | null;
  detail: string;
}

export type ReturnDomainResult =
  { ok: true; view: ReturnDomainView } | { ok: false; error: string };

function fail(e: unknown, what: string): { ok: false; error: string } {
  if (!(e instanceof IvoraError)) throw e;
  console.error(
    `cpo-starter-kit: ${what} failed:`,
    `${e.code} (HTTP ${e.status}) ${e.requestId ?? ""}`.trim(),
  );
  const scopes =
    e.status === 401 || e.status === 403
      ? " The API key needs stations:read (list) and stations:write (register, verify): see the README."
      : "";
  return { ok: false, error: `${describeError(e)}${scopes}` };
}

/** The TXT record Ivora asks for, from the domain's `dns_records`. */
export function txtOf(domain: ReturnDomain) {
  const r = (domain.dns_records ?? []).find(
    (x) => x.type.toUpperCase() === "TXT",
  );
  return r ? { name: r.name, value: r.value } : null;
}

/** This deployment's hostname among the domains; a disabled one is not registered. */
function findDomain(list: ReturnDomain[], host: string) {
  return (
    list.find(
      (x) => x.hostname.toLowerCase() === host && x.status !== "disabled",
    ) ?? null
  );
}

export function domainView(
  hostname: string,
  domain: ReturnDomain | null,
): ReturnDomainView {
  if (!domain || domain.status === "disabled")
    return {
      state: "not_registered",
      hostname,
      id: null,
      txt: null,
      detail: `${hostname} is not registered yet. Register it to get the TXT record to publish.`,
    };
  if (domain.ready)
    return {
      state: "ready",
      hostname,
      id: domain.id,
      txt: null,
      detail: `${hostname} is verified. Drivers come back to your own session page after paying.`,
    };
  return {
    state: "pending",
    hostname,
    id: domain.id,
    txt: txtOf(domain),
    detail: `Publish the TXT record below at your DNS provider, then choose Verify. DNS can take a few minutes. Until ${hostname} is verified, drivers come back to Ivora's driver page.`,
  };
}

const hostOf = (base: QrBase) =>
  base.ok ? new URL(base.base).hostname.toLowerCase() : null;

/** Reads the return domains and finds this deployment's hostname among them. */
export async function loadReturnDomain(
  d: { ivora: IvoraClient },
  base: QrBase,
  demo: boolean,
): Promise<ReturnDomainResult> {
  if (demo)
    return {
      ok: true,
      view: {
        state: "demo",
        hostname: "charge.example.com",
        id: null,
        txt: returnTxtRecord("charge.example.com", "sample-token-not-real"),
        detail:
          "Demo: sample record only. Nothing is registered or sent to Ivora. With live credentials, this step registers your hostname and checks the TXT record.",
      },
    };
  const host = hostOf(base);
  if (!host)
    return {
      ok: true,
      view: {
        state: "no_origin",
        hostname: null,
        id: null,
        txt: null,
        detail: base.ok
          ? ""
          : `${base.reason} The return domain is the hostname of PUBLIC_BASE_URL (or APP_URL).`,
      },
    };
  try {
    const list = await d.ivora.listReturnDomains();
    return {
      ok: true,
      view: domainView(host, findDomain(list, host)),
    };
  } catch (e) {
    return fail(e, "return domains read");
  }
}

/**
 * Registers the hostname. One already registered (and not disabled) is shown as it is,
 * with nothing sent. A disabled one is registered again under a new key, which makes
 * Ivora issue a new challenge (the first key would only replay the old answer).
 */
export async function registerReturnDomain(
  d: { ivora: IvoraClient },
  actor: Staff,
  base: QrBase,
  now: () => number = Date.now,
): Promise<ReturnDomainResult> {
  if (!atLeast(actor.role, "manager")) throw notAllowed();
  const host = hostOf(base);
  if (!host)
    return {
      ok: false,
      error:
        "Set PUBLIC_BASE_URL (or APP_URL) to your own stable https domain first.",
    };
  try {
    const list = await d.ivora.listReturnDomains();
    const active = findDomain(list, host);
    if (active) return { ok: true, view: domainView(host, active) };
    const disabled = list.some((x) => x.hostname.toLowerCase() === host);
    const dom = await d.ivora.createReturnDomain(
      host,
      idempotencyKey(
        "return-domain",
        disabled ? `${host}-${now()}` : host,
        "create",
      ),
    );
    return { ok: true, view: domainView(host, dom) };
  } catch (e) {
    return fail(e, "return domain register");
  }
}

/**
 * Asks Ivora to look for the TXT record now. Each press is its own request (a new key),
 * so a record published a minute ago is found; the `ready` flag is Ivora's answer.
 */
export async function verifyReturnDomain(
  d: { ivora: IvoraClient },
  actor: Staff,
  base: QrBase,
  now: () => number = Date.now,
): Promise<ReturnDomainResult> {
  if (!atLeast(actor.role, "manager")) throw notAllowed();
  const host = hostOf(base);
  if (!host)
    return {
      ok: false,
      error:
        "Set PUBLIC_BASE_URL (or APP_URL) to your own stable https domain first.",
    };
  try {
    // Verifying a disabled domain is a 409: it must be registered again first.
    const found = findDomain(await d.ivora.listReturnDomains(), host);
    if (!found)
      return {
        ok: false,
        error: `${host} is not registered yet. Register it first.`,
      };
    const dom = await d.ivora.verifyReturnDomain(
      found.id,
      idempotencyKey("return-domain", `${found.id}-${now()}`, "verify"),
    );
    return { ok: true, view: domainView(host, { ...found, ...dom }) };
  } catch (e) {
    return fail(e, "return domain verify");
  }
}
