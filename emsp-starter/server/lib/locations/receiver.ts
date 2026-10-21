import "server-only";
import { OcpiProblem } from "@/lib/ocpi/errors";
import {
  dateTimeMs,
  parseConnector,
  parseEvse,
  parseLocation,
  parsePatch,
  sameId,
  type Evse,
  type Location,
} from "@/lib/ocpi/locations";
import { ocpiResponse, readJson, type OcpiContext } from "@/lib/ocpi/server";
import { parseTariff, type Tariff } from "@/lib/ocpi/tariffs";
import { STATUS } from "@/lib/ocpi/types";
import { locationStore } from "./registry";
import type { LocationStore, ObjectKey } from "./store";

/**
 * Our Locations and Tariffs Receiver interfaces (OCPI 2.2.1 sections 8.2.2 and 11.2.2):
 * a CPO pushes changes as they happen.
 *
 *   /ocpi/2.2.1/locations/{country_code}/{party_id}/{location_id}[/{evse_uid}[/{connector_id}]]
 *     GET, PUT, PATCH
 *   /ocpi/2.2.1/tariffs/{country_code}/{party_id}/{tariff_id}
 *     GET, PUT, PATCH, DELETE
 *
 * The country code and party ID in the URL must be a party of the calling peer, and
 * objects are stored under that peer only. Every body is validated against 2.2.1; a
 * PATCH is merged into the stored object and the result validated as a whole. A change
 * older than what we hold (by last_updated) is acknowledged and ignored, so a late push
 * never overwrites newer data. An EVSE is never deleted: a CPO sets it to REMOVED.
 */

const invalid = (message: string) =>
  new OcpiProblem(400, STATUS.INVALID_PARAMETERS, message);
const unknown = (what: string) =>
  new OcpiProblem(404, STATUS.UNKNOWN_LOCATION, `Unknown ${what}`);
const notAllowed = () =>
  new OcpiProblem(405, STATUS.CLIENT_ERROR, "Method not allowed");

const SEGMENT = /^[\x21-\x7e]{1,36}$/;

/** Path segments after the module's base path, decoded and checked. */
function segments(ctx: OcpiContext, module: "locations" | "tariffs") {
  const path = new URL(ctx.request.url).pathname;
  const base = `/ocpi/2.2.1/${module}/`;
  if (!path.startsWith(base)) throw invalid("Unknown path");
  let parts: string[];
  try {
    parts = path
      .slice(base.length)
      .replace(/\/+$/, "")
      .split("/")
      .map(decodeURIComponent);
  } catch {
    throw invalid("Invalid path");
  }
  if (parts.length < 3 || parts.some((p) => !SEGMENT.test(p)))
    throw invalid(
      "Path must be /{country_code}/{party_id}/{id}, with IDs of 1 to 36 characters",
    );
  const [countryCode, partyId] = parts;
  if (!/^[A-Za-z]{2}$/.test(countryCode) || !/^[A-Za-z0-9]{3}$/.test(partyId))
    throw invalid("Invalid country_code or party_id in the path");
  // Only the peer's own parties: a CPO cannot write another CPO's locations.
  const own = ctx.peer.roles.some(
    (r) => sameId(r.country_code, countryCode) && sameId(r.party_id, partyId),
  );
  if (!own)
    throw new OcpiProblem(
      403,
      STATUS.CLIENT_ERROR,
      "The country_code and party_id in the path are not a party of this token",
    );
  return {
    key: {
      peerId: ctx.peer.id,
      countryCode: countryCode.toUpperCase(),
      partyId: partyId.toUpperCase(),
      id: parts[2],
    } satisfies ObjectKey,
    rest: parts.slice(3),
  };
}

function valid<T>(
  what: string,
  parsed: { ok: true; value: T } | { ok: false; errors: string[] },
): T {
  if (!parsed.ok)
    throw invalid(`Invalid ${what}: ${parsed.errors.slice(0, 10).join("; ")}`);
  return parsed.value;
}

/** True when `incoming` is older than what we hold: acknowledge, do not apply. */
const stale = (held: string, incoming: string) =>
  dateTimeMs(incoming) < dateTimeMs(held);

const later = (a: string, b: string) =>
  dateTimeMs(a) >= dateTimeMs(b) ? a : b;

/** The identifying fields of a PUT or PATCH body must match the URL. */
function checkIds(body: Record<string, unknown>, ids: Record<string, string>) {
  for (const [field, expected] of Object.entries(ids)) {
    const v = body[field];
    if (v !== undefined && (typeof v !== "string" || !sameId(v, expected)))
      throw invalid(`${field} in the body does not match the URL`);
  }
}

const asObject = (v: unknown) =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

async function saveLocation(
  store: LocationStore,
  ctx: OcpiContext,
  location: Location,
) {
  await store.saveLocations(ctx.peer.id, [location], new Date().toISOString());
  return ocpiResponse(undefined, ctx);
}

/** Every request to /ocpi/2.2.1/locations/... */
export async function locationsReceiver(ctx: OcpiContext): Promise<Response> {
  const { key, rest } = segments(ctx, "locations");
  if (rest.length > 2) throw invalid("Path is too long");
  const [evseUid, connectorId] = rest;
  const store = locationStore();
  const method = ctx.request.method;
  if (method !== "GET" && method !== "PUT" && method !== "PATCH")
    throw notAllowed();

  const held = await store.getLocation(key);

  // PUT of a whole location: the only request that may create one.
  if (evseUid === undefined && method === "PUT") {
    const body = asObject(await readJson(ctx.request));
    checkIds(body, {
      country_code: key.countryCode,
      party_id: key.partyId,
      id: key.id,
    });
    const location = valid(
      "location",
      parseLocation({
        ...body,
        country_code: key.countryCode,
        party_id: key.partyId,
        id: key.id,
      }),
    );
    if (held && stale(held.location.last_updated, location.last_updated))
      return ocpiResponse(undefined, ctx);
    return saveLocation(store, ctx, location);
  }

  if (!held) throw unknown("location");
  const location = held.location;

  if (evseUid === undefined) {
    if (method === "GET") return ocpiResponse(location, ctx);
    const patch = valid("patch", parsePatch(await readJson(ctx.request)));
    checkIds(patch, {
      country_code: key.countryCode,
      party_id: key.partyId,
      id: key.id,
    });
    if (stale(location.last_updated, patch.last_updated as string))
      return ocpiResponse(undefined, ctx);
    const merged = valid("location", parseLocation({ ...location, ...patch }));
    return saveLocation(store, ctx, merged);
  }

  const evses = location.evses ?? [];
  const index = evses.findIndex((e) => sameId(e.uid, evseUid));
  const evse = index >= 0 ? evses[index] : undefined;

  /** Replaces (or adds) the EVSE and moves the location's last_updated forward. */
  const withEvse = (next: Evse): Location => {
    const list = [...evses];
    if (index >= 0) list[index] = next;
    else list.push(next);
    return {
      ...location,
      evses: list,
      last_updated: later(location.last_updated, next.last_updated),
    };
  };

  if (connectorId === undefined) {
    if (method === "GET") {
      if (!evse) throw unknown("EVSE");
      return ocpiResponse(evse, ctx);
    }
    if (method === "PUT") {
      const body = asObject(await readJson(ctx.request));
      checkIds(body, { uid: evseUid });
      const next = valid(
        "EVSE",
        parseEvse({ ...body, uid: evse?.uid ?? evseUid }),
      );
      if (evse && stale(evse.last_updated, next.last_updated))
        return ocpiResponse(undefined, ctx);
      return saveLocation(store, ctx, withEvse(next));
    }
    if (!evse) throw unknown("EVSE");
    const patch = valid("patch", parsePatch(await readJson(ctx.request)));
    checkIds(patch, { uid: evseUid });
    if (stale(evse.last_updated, patch.last_updated as string))
      return ocpiResponse(undefined, ctx);
    const next = valid("EVSE", parseEvse({ ...evse, ...patch }));
    return saveLocation(store, ctx, withEvse(next));
  }

  if (!evse) throw unknown("EVSE");
  const connectors = evse.connectors;
  const ci = connectors.findIndex((c) => sameId(c.id, connectorId));
  const connector = ci >= 0 ? connectors[ci] : undefined;
  if (method === "GET") {
    if (!connector) throw unknown("connector");
    return ocpiResponse(connector, ctx);
  }
  let next;
  if (method === "PUT") {
    const body = asObject(await readJson(ctx.request));
    checkIds(body, { id: connectorId });
    next = valid(
      "connector",
      parseConnector({ ...body, id: connector?.id ?? connectorId }),
    );
    if (connector && stale(connector.last_updated, next.last_updated))
      return ocpiResponse(undefined, ctx);
  } else {
    if (!connector) throw unknown("connector");
    const patch = valid("patch", parsePatch(await readJson(ctx.request)));
    checkIds(patch, { id: connectorId });
    if (stale(connector.last_updated, patch.last_updated as string))
      return ocpiResponse(undefined, ctx);
    next = valid("connector", parseConnector({ ...connector, ...patch }));
  }
  const list = [...connectors];
  if (ci >= 0) list[ci] = next;
  else list.push(next);
  return saveLocation(
    store,
    ctx,
    withEvse({
      ...evse,
      connectors: list,
      last_updated: later(evse.last_updated, next.last_updated),
    }),
  );
}

/** Every request to /ocpi/2.2.1/tariffs/... */
export async function tariffsReceiver(ctx: OcpiContext): Promise<Response> {
  const { key, rest } = segments(ctx, "tariffs");
  if (rest.length) throw invalid("Path is too long");
  const store = locationStore();
  const method = ctx.request.method;
  const held = await store.getTariff(key);
  const ids = {
    country_code: key.countryCode,
    party_id: key.partyId,
    id: key.id,
  };
  const save = async (tariff: Tariff) => {
    await store.saveTariffs(ctx.peer.id, [tariff], new Date().toISOString());
    return ocpiResponse(undefined, ctx);
  };

  switch (method) {
    case "GET":
      if (!held) throw unknown("tariff");
      return ocpiResponse(held.tariff, ctx);
    case "PUT": {
      const body = asObject(await readJson(ctx.request));
      checkIds(body, ids);
      const tariff = valid("tariff", parseTariff({ ...body, ...ids }));
      if (held && stale(held.tariff.last_updated, tariff.last_updated))
        return ocpiResponse(undefined, ctx);
      return save(tariff);
    }
    case "PATCH": {
      // 2.2.1 defines PUT and DELETE for tariffs; PATCH is accepted from CPOs that send it.
      if (!held) throw unknown("tariff");
      const patch = valid("patch", parsePatch(await readJson(ctx.request)));
      checkIds(patch, ids);
      if (stale(held.tariff.last_updated, patch.last_updated as string))
        return ocpiResponse(undefined, ctx);
      return save(valid("tariff", parseTariff({ ...held.tariff, ...patch })));
    }
    case "DELETE":
      if (!held) throw unknown("tariff");
      await store.deleteTariff(key);
      return ocpiResponse(undefined, ctx);
    default:
      throw notAllowed();
  }
}
