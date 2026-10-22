import "server-only";
import { createHash } from "node:crypto";
import { atLeast } from "@/lib/roles";
import { AccessDeniedError } from "../auth";
import {
  describeError,
  idempotencyKey,
  IvoraError,
  type IvoraClient,
  type OcpiPartyRef,
  type OcpiSettings,
  type OcpiSettingsInput,
} from "../ivora";
import { demoDecideParty, type DemoOcpiStore } from "../ivora/demo-ocpi";
import type { Staff } from "../team/types";
import { parseRoamingForm, type RoamingForm } from "./input";
import { RoamingError, type RoamingEvseId, type RoamingView } from "./types";

// OCPI roaming placeholder: the operator's publishing settings in Ivora
// (GET/PUT /v1/tenants/{id}/ocpi) and the EVSE IDs Ivora holds for them
// (GET /ocpi/evse-ids, read only). The kit keeps no copy of these settings.

export interface RoamingDeps {
  ivora: IvoraClient;
  /** Demo mode only: the stand-in for Ivora staff's decision on a party request. */
  demoOcpi: DemoOcpiStore | null;
}

/** Owners and managers: publishing decides what partners show of the network. */
function allowed(actor: Staff) {
  if (!atLeast(actor.role, "manager")) throw new AccessDeniedError("manager");
}

/** The most excluded locations one PUT takes. */
export const MAX_EXCLUDED = 1000;

export const partyLabel = (p: OcpiPartyRef) =>
  `${p.country_code}*${p.party_id}`;

const revisionOf = (s: OcpiSettings) => s.updated_at ?? "default";

const message = (e: unknown) =>
  e instanceof IvoraError ? describeError(e) : "Could not read from Ivora.";

export async function loadRoaming(
  deps: RoamingDeps,
  actor: Staff,
): Promise<RoamingView> {
  allowed(actor);
  const { ivora } = deps;
  const settings = await ivora.getOcpiSettings();
  const excluded = new Set(settings.excluded_location_ids);

  const [sites, evse] = await Promise.allSettled([
    ivora.listAllLocations(),
    ivora.getOcpiEvseIds(),
  ]);

  let evseIds: RoamingEvseId[] = [];
  let evseIdsError: string | null = null;
  if (evse.status === "fulfilled") {
    let names = new Map<number, string>();
    if (evse.value.data.length)
      try {
        const st = await ivora.listAllStations();
        names = new Map(st.data.map((s) => [s.id, s.name]));
      } catch {
        // Names are a convenience: the IDs still show.
      }
    evseIds = [...evse.value.data]
      .sort(
        (a, b) => a.station_id - b.station_id || a.evse_number - b.evse_number,
      )
      .map((x) => ({ ...x, stationName: names.get(x.station_id) ?? null }));
  } else evseIdsError = message(evse.reason);

  const listed =
    sites.status === "fulfilled"
      ? sites.value.data.map((l) => ({
          id: l.id,
          name: l.name,
          published: !excluded.has(l.id),
        }))
      : [];
  const listedIds = new Set(listed.map((l) => l.id));
  return {
    demo: ivora.mode === "demo",
    settings,
    revision: revisionOf(settings),
    sites: listed,
    otherExcluded:
      sites.status === "fulfilled"
        ? settings.excluded_location_ids.filter((id) => !listedIds.has(id))
        : [...excluded],
    sitesTruncated: sites.status === "fulfilled" && sites.value.truncated,
    sitesError: sites.status === "rejected" ? message(sites.reason) : null,
    evseIds,
    evseIdsError,
  };
}

/** Same settings, as far as the kit sends them. */
function sameSettings(a: OcpiSettings, b: OcpiSettingsInput): boolean {
  const party = (p: OcpiPartyRef | null) => (p ? partyLabel(p) : null);
  const sorted = (x: number[]) => [...x].sort((m, n) => m - n).join(",");
  return (
    a.publish === b.publish &&
    a.display_name === b.display_name &&
    a.website === b.website &&
    a.time_zone === b.time_zone &&
    sorted(a.excluded_location_ids) === sorted(b.excluded_location_ids) &&
    party(a.own_party) === party(b.own_party)
  );
}

/**
 * One key per change from one starting point: a retry of the same save reuses it
 * (Ivora answers with the first result), a different save or a save over a newer
 * change gets its own.
 */
export function roamingKey(revision: string, body: OcpiSettingsInput): string {
  const digest = createHash("sha256")
    .update(`${revision}\n${JSON.stringify(body)}`)
    .digest("hex")
    .slice(0, 32);
  return idempotencyKey("ocpi-settings", digest, "put");
}

export interface RoamingSaved {
  settings: OcpiSettings;
  /** The request is new or changed: Ivora has to approve it first. */
  partyRequested: boolean;
}

/**
 * Saves the Roaming form. PUT /ocpi replaces every setting, so the whole object is
 * sent: what the form edits, the excluded sites it did not list, and the connector
 * defaults the kit does not edit (as Ivora last answered them).
 */
export async function saveRoaming(
  deps: RoamingDeps,
  actor: Staff,
  form: RoamingForm,
): Promise<RoamingSaved> {
  allowed(actor);
  const parsed = parseRoamingForm(form);
  if (!parsed.ok)
    throw new RoamingError(
      "invalid",
      parsed.problems[0],
      parsed.problems.slice(1),
    );
  const v = parsed.value;
  const current = await deps.ivora.getOcpiSettings();

  const shown = new Set(v.shownLocations);
  const ticked = new Set(v.publishedLocations);
  const excluded = [
    ...current.excluded_location_ids.filter((id) => !shown.has(id)),
    ...v.shownLocations.filter((id) => !ticked.has(id)),
  ];
  const excludedIds = [...new Set(excluded)].sort((a, b) => a - b);
  if (excludedIds.length > MAX_EXCLUDED)
    throw new RoamingError(
      "too_many_excluded",
      `Ivora keeps at most ${MAX_EXCLUDED} unpublished sites. Publish some of them, or turn publishing off.`,
    );

  const body: OcpiSettingsInput = {
    publish: v.publish,
    display_name: v.displayName,
    website: v.website,
    time_zone: v.timeZone,
    connector_defaults: current.connector_defaults,
    excluded_location_ids: excludedIds,
    own_party: v.ownParty,
  };

  if (revisionOf(current) !== v.revision) {
    // Already saved (a retried submit after a lost answer): nothing to do.
    if (sameSettings(current, body))
      return { settings: current, partyRequested: false };
    throw new RoamingError(
      "stale",
      "Someone changed the roaming settings since you opened this page. Reload it to see their change, then make yours again.",
    );
  }

  const before = current.own_party;
  let settings: OcpiSettings;
  try {
    settings = await deps.ivora.putOcpiSettings(
      body,
      roamingKey(v.revision, body),
    );
  } catch (e) {
    throw friendly(e, body);
  }
  const after = settings.own_party;
  return {
    settings,
    partyRequested:
      !!after &&
      after.status !== "approved" &&
      (!before || partyLabel(before) !== partyLabel(after)),
  };
}

/** The two 409s staff can act on, in plain words; anything else as Ivora said it. */
function friendly(e: unknown, body: OcpiSettingsInput): unknown {
  if (!(e instanceof IvoraError) || e.status !== 409) return e;
  if (e.code === "ocpi_tenant_private")
    return new RoamingError(
      "tenant_private",
      "Ivora keeps this network private, so it can't be published to roaming partners. Save again with publishing off, or contact Ivora support if this network should be public.",
    );
  if (e.code === "ocpi_party_in_use" && body.own_party)
    return new RoamingError(
      "party_in_use",
      `Ivora has already approved party ${partyLabel(body.own_party)} for another operator, so it can't be requested here. If the registry issued it to you, contact Ivora support with the registry entry. Or leave the party ID empty to publish under Ivora's shared party.`,
    );
  return e;
}

/**
 * Demo only: simulates Ivora staff approving or rejecting the requested party, so the
 * demo can show every state. In live mode only Ivora decides, and this refuses.
 */
export async function decideDemoParty(
  deps: RoamingDeps,
  actor: Staff,
  decision: "approve" | "reject",
): Promise<void> {
  allowed(actor);
  if (!deps.demoOcpi || deps.ivora.mode !== "demo")
    throw new RoamingError(
      "demo_only",
      "Only Ivora approves a party ID. This button exists in demo mode only.",
    );
  const s = await deps.demoOcpi.load();
  if (!s.own_party)
    throw new RoamingError("invalid", "Request a party ID first.");
  await deps.demoOcpi.save(demoDecideParty(s, decision));
}
