import "server-only";
import { sameId } from "@/lib/ocpi/locations";
import { mode } from "@/lib/server/demo";
import { displayPrice, previewCost, primaryTariff } from "./pricing";
import { locationStore, visiblePeerIds } from "./registry";
import {
  locationDetail,
  parseLocationAppId,
  parseSearchQuery,
  searchLocations,
  SearchQueryError,
  tariffsFor,
  tariffsOfLocation,
} from "./search";
import type { StoredLocation } from "./store";

/**
 * The app's location API: search, one location, and a price preview. Locations and
 * tariffs are public charging information, not driver data, so any origin may read
 * them. Every answer says the mode, so the app can label demo data.
 */
const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};

export const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: HEADERS });

export const preflight = () =>
  new Response(null, {
    status: 204,
    headers: { ...HEADERS, "Access-Control-Allow-Methods": "GET, OPTIONS" },
  });

const failed = (what: string, e: unknown) => {
  // Name the error only: messages may carry database or peer details.
  console.error(
    `Location API ${what} failed: ${e instanceof Error ? e.name : "unknown error"}`,
  );
  return json({ error: "Something went wrong" }, 500);
};

export async function searchResponse(request: Request): Promise<Response> {
  let query;
  try {
    query = parseSearchQuery(new URL(request.url).searchParams);
  } catch (e) {
    if (e instanceof SearchQueryError) return json({ error: e.message }, 400);
    throw e;
  }
  try {
    const result = await searchLocations(
      locationStore(),
      await visiblePeerIds(),
      query,
    );
    return json({ mode: mode(), ...result });
  } catch (e) {
    return failed("search", e);
  }
}

/** A published location of a visible peer, by the app's ID. */
async function findLocation(id: string): Promise<StoredLocation | null> {
  const key = parseLocationAppId(id);
  if (!key || !(await visiblePeerIds()).includes(key.peerId)) return null;
  const held = await locationStore().getLocation(key);
  return held?.location.publish ? held : null;
}

export async function detailResponse(id: string): Promise<Response> {
  try {
    const held = await findLocation(id);
    if (!held) return json({ error: "Location not found" }, 404);
    const byPeer = await tariffsFor(locationStore(), [held]);
    return json({
      mode: mode(),
      location: locationDetail(held, tariffsOfLocation(held, byPeer)),
    });
  } catch (e) {
    return failed("detail", e);
  }
}

function num(q: URLSearchParams, name: string, max: number, fallback?: number) {
  const v = q.get(name)?.trim();
  if (!v) {
    if (fallback === undefined)
      throw new SearchQueryError(`${name} is required`);
    return fallback;
  }
  const n = /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
  if (!(n >= 0 && n <= max))
    throw new SearchQueryError(`${name} must be a number from 0 to ${max}`);
  return n;
}

/**
 * GET .../price-preview?evse_uid=&connector_id=&kwh=&minutes=[&parking_minutes=][&start=]
 * What a session at one connector would cost under its tariff. Display only.
 */
export async function previewResponse(
  id: string,
  request: Request,
): Promise<Response> {
  const q = new URL(request.url).searchParams;
  let session;
  try {
    const start = q.get("start")?.trim();
    const startAt = start ? new Date(start) : new Date();
    if (Number.isNaN(startAt.getTime()))
      throw new SearchQueryError("start must be a date and time");
    session = {
      evseUid: q.get("evse_uid")?.trim() ?? "",
      connectorId: q.get("connector_id")?.trim() ?? "",
      start: startAt,
      energyKwh: num(q, "kwh", 1_000),
      chargingMinutes: num(q, "minutes", 24 * 60),
      parkingMinutes: num(q, "parking_minutes", 24 * 60, 0),
    };
    if (!session.evseUid || !session.connectorId)
      throw new SearchQueryError("evse_uid and connector_id are required");
  } catch (e) {
    if (e instanceof SearchQueryError) return json({ error: e.message }, 400);
    throw e;
  }
  try {
    const held = await findLocation(id);
    const evse = held?.location.evses?.find(
      (e) => sameId(e.uid, session.evseUid) && e.status !== "REMOVED",
    );
    const connector = evse?.connectors.find((c) =>
      sameId(c.id, session.connectorId),
    );
    if (!held || !connector) return json({ error: "Connector not found" }, 404);
    const byPeer = await tariffsFor(locationStore(), [held]);
    const tariff = primaryTariff(
      connector.tariff_ids,
      tariffsOfLocation(held, byPeer),
      session.start,
    );
    if (!tariff)
      return json({ error: "No tariff is known for this connector" }, 404);
    return json({
      mode: mode(),
      display_only: true,
      price: displayPrice(tariff),
      preview: previewCost(tariff, {
        ...session,
        timeZone: held.location.time_zone,
      }),
    });
  } catch (e) {
    return failed("price preview", e);
  }
}
