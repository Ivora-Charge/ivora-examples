import "server-only";
import type { HostFilter } from "@/lib/hosts";
import { HOST_ROLE } from "@/lib/roles";
import { IvoraError, type IvoraClient } from "./ivora";
import type { SiteAssignment } from "./hosts/types";
import type { Staff } from "./team/types";

// Network mode: which sites the signed-in user sees. Every charger stays in the
// operator's one Ivora project, so a host user's view is the operator's Ivora client
// narrowed to the sites of their host, which the server read from the kit's database.
// Station and location IDs from a browser are never trusted: a read or command on a
// station outside the scope answers 404, as if it did not exist.

/** A set of sites (Ivora location IDs). */
export interface SiteScope {
  /** True for a site in the scope. A station without a site is the operator's own. */
  allows(locationId: number | null | undefined): boolean;
}

/** Exactly these sites. */
export const sitesScope = (ids: Iterable<number>): SiteScope => {
  const set = new Set(ids);
  return { allows: (id) => typeof id === "number" && set.has(id) };
};

/** Every site except these (the operator's own sites: none of a host's). */
const exceptScope = (ids: Iterable<number>): SiteScope => {
  const set = new Set(ids);
  return { allows: (id) => typeof id !== "number" || !set.has(id) };
};

/**
 * The host filter of an operator page as a scope: null for every site (no filter),
 * the operator's own sites, or one host's sites.
 */
export function filterScope(
  f: HostFilter,
  sites: SiteAssignment[],
): SiteScope | null {
  if (f.kind === "all") return null;
  if (f.kind === "own") return exceptScope(sites.map((s) => s.locationId));
  return sitesScope(
    sites.filter((s) => s.hostId === f.hostId).map((s) => s.locationId),
  );
}

/** A host user's scope: their host's sites. Null for operator staff (every site). */
export function staffScope(staff: Staff): SiteScope | null {
  if (staff.role !== HOST_ROLE) return null;
  // A host user always has a host here (staffForUser refuses one without); if not,
  // they see nothing.
  return sitesScope(staff.host?.siteIds ?? []);
}

const outOfScope = () =>
  new IvoraError(404, "not_found", "Not found.", undefined, undefined, {
    scope: "site",
  });

const refused = (method: string) =>
  new IvoraError(
    403,
    "not_in_scope",
    `This is not available to host users (${method}).`,
  );

/** Marks a narrowed client, so the same scope is not applied twice. */
const SCOPED = Symbol("cpo-scoped");

/**
 * The client narrowed to `scope`. List reads return only what is in it; a read or
 * command on one station, transaction or bill outside it answers 404.
 *
 * `strict` (host users): every other method is refused, so a module that was not
 * written for hosts can't reach the rest of the project through this client, and the
 * project-wide figures (`GET /stats`, which has no site filter) are refused too.
 * Without it (an operator's host filter, a display choice), other methods pass through.
 */
export function scopedIvora(
  inner: IvoraClient,
  scope: SiteScope,
  strict: boolean,
): IvoraClient {
  let allowed: Promise<Set<number>> | null = null;
  /** The stations in scope, read once per client (one request). */
  const stations = () =>
    (allowed ??= inner
      .listAllStations()
      .then(
        (l) =>
          new Set(
            l.data.filter((s) => scope.allows(s.location_id)).map((s) => s.id),
          ),
      ));
  const inScope = async (stationId: number | null | undefined) =>
    typeof stationId === "number" && (await stations()).has(stationId);
  const assertStation = async (stationId: number) => {
    if (!(await inScope(stationId))) throw outOfScope();
  };

  const own: Partial<IvoraClient> = {
    async listLocations(o) {
      return (await inner.listLocations(o)).filter((l) => scope.allows(l.id));
    },
    async listAllLocations() {
      const l = await inner.listAllLocations();
      return { ...l, data: l.data.filter((x) => scope.allows(x.id)) };
    },
    async listStations(o) {
      return (await inner.listStations(o)).filter((s) =>
        scope.allows(s.location_id),
      );
    },
    async listAllStations(limits) {
      const l = await inner.listAllStations(limits);
      return { ...l, data: l.data.filter((s) => scope.allows(s.location_id)) };
    },
    async getStation(stationId) {
      // Read fresh: the station's site decides, as Ivora reports it now.
      const s = await inner.getStation(stationId);
      if (!scope.allows(s.location_id)) throw outOfScope();
      return s;
    },
    async sendCommand(stationId, command, key) {
      const s = await inner.getStation(stationId);
      if (!scope.allows(s.location_id)) throw outOfScope();
      return inner.sendCommand(stationId, command, key);
    },
    async listFaults(stationId, o) {
      await assertStation(stationId);
      return inner.listFaults(stationId, o);
    },
    async listTransactions(o = {}) {
      if (o.station_id != null) {
        await assertStation(o.station_id);
        return inner.listTransactions(o);
      }
      const ok = await stations();
      return (await inner.listTransactions(o)).filter(
        (t) => t.station_id != null && ok.has(t.station_id),
      );
    },
    async listTransactionsAfter(o, limits) {
      await assertStation(o.station_id);
      return inner.listTransactionsAfter(o, limits);
    },
    async listSessions(q, limits) {
      if (q.station_id != null) {
        await assertStation(q.station_id);
        return inner.listSessions(q, limits);
      }
      const page = await inner.listSessions(q, limits);
      const ok = await stations();
      return {
        ...page,
        unfiltered: page.unfiltered ?? page.data.length,
        data: page.data.filter(
          (t) => t.station_id != null && ok.has(t.station_id),
        ),
      };
    },
    async listBills(q, limits) {
      if (q.station_id != null) {
        await assertStation(q.station_id);
        return inner.listBills(q, limits);
      }
      const page = await inner.listBills(q, limits);
      const ok = await stations();
      return { ...page, data: page.data.filter((b) => ok.has(b.station_id)) };
    },
    async getTransaction(transactionId, limits) {
      const t = await inner.getTransaction(transactionId, limits);
      // Not a 404: session tracking reads a 404 as "Ivora no longer has it" and
      // forgets the session (lib/server/live/active.ts), which must never follow from
      // a host user's view.
      if (!(await inScope(t.station_id))) throw refused("getTransaction");
      return t;
    },
  };

  // Host users also use these, on records the kit already scoped: an operation of a
  // command on one of their chargers, and the operator's staff token for a remote
  // start (looked up and registered once per operator).
  const passStrict = new Set<keyof IvoraClient>([
    "getOperation",
    "findToken",
    "createToken",
  ]);

  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === SCOPED) return strict;
      if (prop in own) return own[prop as keyof typeof own];
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      if (!strict || passStrict.has(prop as keyof IvoraClient))
        return v.bind(target);
      return () => Promise.reject(refused(String(prop)));
    },
  });
}

/** True when the client is already narrowed strictly (by forStaff). */
export const isScoped = (c: IvoraClient) =>
  Boolean((c as unknown as Record<symbol, unknown>)[SCOPED]);

/**
 * The service dependencies as `staff` may use them: unchanged for operator staff,
 * the Ivora client narrowed (strictly) to their host's sites for a host user. Every
 * service that reads or acts on the network applies this first, whatever page or
 * route called it, so a host user's scope never depends on a page hiding a link.
 */
export function forStaff<D extends { ivora: IvoraClient }>(
  d: D,
  staff: Staff,
): D {
  const scope = staffScope(staff);
  if (!scope || isScoped(d.ivora)) return d;
  return { ...d, ivora: scopedIvora(d.ivora, scope, true) };
}

/** An operator's host filter, applied to the dependencies (display only). */
export function withFilter<D extends { ivora: IvoraClient }>(
  d: D,
  scope: SiteScope | null,
): D {
  if (!scope) return d;
  return { ...d, ivora: scopedIvora(d.ivora, scope, false) };
}

/**
 * The dependencies and scope a service reads with: a host user's own sites (strict,
 * whatever filter was asked for), else the operator's filter, else everything.
 */
export function narrow<D extends { ivora: IvoraClient }>(
  d: D,
  staff: Staff,
  filter: SiteScope | null = null,
): { d: D; scope: SiteScope | null } {
  const own = staffScope(staff);
  if (own) return { d: forStaff(d, staff), scope: own };
  return { d: withFilter(d, filter), scope: filter };
}
