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
import type { ObjectKey } from "./store";

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
/** 2.2.1 has no "unknown tariff" status (2003 is Unknown Location): a client error. */
const unknownTariff = () =>
  new OcpiProblem(404, STATUS.CLIENT_ERROR, "Unknown tariff");
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

/** The request body, read once however many times a retry asks for it. */
function bodyOnce(ctx: OcpiContext) {
  let body: Promise<unknown> | undefined;
  return () => (body ??= readJson(ctx.request));
}

/** What a push does: answer without writing, or write this object. */
type Change<T> = { reply: unknown } | { write: T };

/** Attempts at a compare-and-swap write before answering "busy". */
export const MAX_WRITE_ATTEMPTS = 25;

/**
 * Read, change, compare-and-swap: `attempt` reads the stored object, works out the
 * change and writes it only if the object is unchanged since the read. When another
 * push to the same object got there first, it reads again and re-applies the change
 * on top, after a short random pause so concurrent pushes spread out. A CPO never
 * resends a push we acknowledged, so a lost write would stay wrong until the next pull.
 */
async function withCompareAndSwap(
  ctx: OcpiContext,
  attempt: () => Promise<{ reply: unknown } | { written: boolean }>,
): Promise<Response> {
  for (let i = 0; i < MAX_WRITE_ATTEMPTS; i++) {
    const outcome = await attempt();
    if ("reply" in outcome) return ocpiResponse(outcome.reply, ctx);
    if (outcome.written) return ocpiResponse(undefined, ctx);
    await new Promise((r) =>
      setTimeout(r, Math.random() * Math.min(50, 2 ** i)),
    );
  }
  throw new OcpiProblem(
    503,
    STATUS.SERVER_ERROR,
    "Too many concurrent changes to this object; try again",
  );
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
  const body = bodyOnce(ctx);

  return withCompareAndSwap(ctx, async () => {
    const held = await store.getLocation(key);
    const change = await locationChange(
      held?.location ?? null,
      key,
      method,
      body,
      evseUid,
      connectorId,
    );
    if ("reply" in change) return change;
    const written = await store.putLocation(
      ctx.peer.id,
      change.write,
      new Date().toISOString(),
      held?.revision ?? null,
    );
    return { written };
  });
}

/**
 * The change a location push makes to `location` (null: we hold none). Pure apart from
 * reading the body, so it can run again on a fresh read.
 */
async function locationChange(
  location: Location | null,
  key: ObjectKey,
  method: "GET" | "PUT" | "PATCH",
  body: () => Promise<unknown>,
  evseUid: string | undefined,
  connectorId: string | undefined,
): Promise<Change<Location>> {
  const ack = { reply: undefined };

  // PUT of a whole location: the only request that may create one.
  if (evseUid === undefined && method === "PUT") {
    const raw = asObject(await body());
    checkIds(raw, {
      country_code: key.countryCode,
      party_id: key.partyId,
      id: key.id,
    });
    const next = valid(
      "location",
      parseLocation({
        ...raw,
        country_code: key.countryCode,
        party_id: key.partyId,
        id: key.id,
      }),
    );
    if (location && stale(location.last_updated, next.last_updated)) return ack;
    return { write: next };
  }

  if (!location) throw unknown("location");

  if (evseUid === undefined) {
    if (method === "GET") return { reply: location };
    const patch = valid("patch", parsePatch(await body()));
    checkIds(patch, {
      country_code: key.countryCode,
      party_id: key.partyId,
      id: key.id,
    });
    if (stale(location.last_updated, patch.last_updated as string)) return ack;
    return {
      write: valid("location", parseLocation({ ...location, ...patch })),
    };
  }

  const evses = location.evses ?? [];
  const index = evses.findIndex((e) => sameId(e.uid, evseUid));
  const evse = index >= 0 ? evses[index] : undefined;

  /** Replaces (or adds) the EVSE and moves the location's last_updated forward. */
  const withEvse = (next: Evse): Change<Location> => {
    const list = [...evses];
    if (index >= 0) list[index] = next;
    else list.push(next);
    return {
      write: {
        ...location,
        evses: list,
        last_updated: later(location.last_updated, next.last_updated),
      },
    };
  };

  if (connectorId === undefined) {
    if (method === "GET") {
      if (!evse) throw unknown("EVSE");
      return { reply: evse };
    }
    if (method === "PUT") {
      const raw = asObject(await body());
      checkIds(raw, { uid: evseUid });
      const next = valid(
        "EVSE",
        parseEvse({ ...raw, uid: evse?.uid ?? evseUid }),
      );
      if (evse && stale(evse.last_updated, next.last_updated)) return ack;
      return withEvse(next);
    }
    if (!evse) throw unknown("EVSE");
    const patch = valid("patch", parsePatch(await body()));
    checkIds(patch, { uid: evseUid });
    if (stale(evse.last_updated, patch.last_updated as string)) return ack;
    return withEvse(valid("EVSE", parseEvse({ ...evse, ...patch })));
  }

  if (!evse) throw unknown("EVSE");
  const connectors = evse.connectors;
  const ci = connectors.findIndex((c) => sameId(c.id, connectorId));
  const connector = ci >= 0 ? connectors[ci] : undefined;
  if (method === "GET") {
    if (!connector) throw unknown("connector");
    return { reply: connector };
  }
  let next;
  if (method === "PUT") {
    const raw = asObject(await body());
    checkIds(raw, { id: connectorId });
    next = valid(
      "connector",
      parseConnector({ ...raw, id: connector?.id ?? connectorId }),
    );
    if (connector && stale(connector.last_updated, next.last_updated))
      return ack;
  } else {
    if (!connector) throw unknown("connector");
    const patch = valid("patch", parsePatch(await body()));
    checkIds(patch, { id: connectorId });
    if (stale(connector.last_updated, patch.last_updated as string)) return ack;
    next = valid("connector", parseConnector({ ...connector, ...patch }));
  }
  const list = [...connectors];
  if (ci >= 0) list[ci] = next;
  else list.push(next);
  return withEvse({
    ...evse,
    connectors: list,
    last_updated: later(evse.last_updated, next.last_updated),
  });
}

/** Every request to /ocpi/2.2.1/tariffs/... */
export async function tariffsReceiver(ctx: OcpiContext): Promise<Response> {
  const { key, rest } = segments(ctx, "tariffs");
  if (rest.length) throw invalid("Path is too long");
  const store = locationStore();
  const method = ctx.request.method;
  if (!["GET", "PUT", "PATCH", "DELETE"].includes(method)) throw notAllowed();
  const body = bodyOnce(ctx);
  const ids = {
    country_code: key.countryCode,
    party_id: key.partyId,
    id: key.id,
  };
  const ack = { reply: undefined };

  return withCompareAndSwap(ctx, async () => {
    const held = await store.getTariff(key);
    const put = async (tariff: Tariff) => ({
      written: await store.putTariff(
        ctx.peer.id,
        tariff,
        new Date().toISOString(),
        held?.revision ?? null,
      ),
    });
    switch (method) {
      case "GET":
        if (!held) throw unknownTariff();
        return { reply: held.tariff };
      case "PUT": {
        const raw = asObject(await body());
        checkIds(raw, ids);
        const tariff = valid("tariff", parseTariff({ ...raw, ...ids }));
        if (held && stale(held.tariff.last_updated, tariff.last_updated))
          return ack;
        return put(tariff);
      }
      case "PATCH": {
        // 2.2.1 defines PUT and DELETE for tariffs; PATCH is accepted from CPOs that send it.
        if (!held) throw unknownTariff();
        const patch = valid("patch", parsePatch(await body()));
        checkIds(patch, ids);
        if (stale(held.tariff.last_updated, patch.last_updated as string))
          return ack;
        return put(valid("tariff", parseTariff({ ...held.tariff, ...patch })));
      }
      default:
        if (!held) throw unknownTariff();
        return { written: await store.deleteTariff(key, held.revision) };
    }
  });
}
