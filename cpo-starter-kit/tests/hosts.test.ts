import { describe, expect, it, vi } from "vitest";
import {
  anyCommand,
  commandRights,
  HOST_PERMISSIONS,
  hostFilterParam,
  may,
  NO_PERMISSIONS,
  parseHostFilter,
  permissionFor,
  readsNetwork,
  type HostAccess,
  type Member,
  type NetworkAction,
} from "@/lib/hosts";
import { modulesFor } from "@/lib/modules";
import {
  assignableRoles,
  atLeast,
  canChangeRole,
  canInvite,
  canRemove,
  HOST_ROLE,
  isMemberRole,
  isRole,
  ROLES,
} from "@/lib/roles";
import { IvoraError, type IvoraClient, type Station } from "@/lib/server/ivora";
import {
  filterScope,
  forStaff,
  narrow,
  scopedIvora,
  sitesScope,
  staffScope,
} from "@/lib/server/scope";
import { trackTransactionById } from "@/lib/server/live/active";
import type { Staff } from "@/lib/server/team/types";

// Network mode: the rules for host users (lib/hosts.ts, lib/roles.ts) and the scoped
// Ivora client every network read and command goes through (lib/server/scope.ts).

const SITE_A = 11;
const SITE_A2 = 12;
const SITE_B = 21;
const OWN_SITE = 31;

const hostA = (permissions = NO_PERMISSIONS): HostAccess => ({
  id: "demo-host-a",
  name: "Sample Host A",
  siteIds: [SITE_A, SITE_A2],
  permissions: { ...permissions },
});

const hostUser = (permissions = NO_PERMISSIONS): Staff => ({
  userId: "00000000-0000-4000-8000-0000000000a1",
  email: "host-user@example.com",
  role: HOST_ROLE,
  operatorId: "op",
  operatorName: "Sample Operator",
  demo: true,
  host: hostA(permissions),
});

const staff = (role: Staff["role"]): Staff => ({
  userId: `00000000-0000-4000-8000-0000000000${role.length}0`,
  email: `${role}@example.com`,
  role,
  operatorId: "op",
  operatorName: "Sample Operator",
  demo: true,
});

const ALL_ON = Object.fromEntries(
  HOST_PERMISSIONS.map((p) => [p, true]),
) as typeof NO_PERMISSIONS;
const ACTIONS: NetworkAction[] = [
  "start",
  "stop",
  "reset",
  "unlock",
  "prices",
  "invite",
  "hosts",
];

describe("the host role", () => {
  it("ranks below every operator role, so no operator check lets it through", () => {
    for (const min of ROLES) expect(atLeast(HOST_ROLE, min)).toBe(false);
    expect(isRole(HOST_ROLE)).toBe(false);
    expect(isMemberRole(HOST_ROLE)).toBe(true);
    expect(isMemberRole("admin")).toBe(false);
    expect(assignableRoles(HOST_ROLE)).toEqual([]);
    for (const r of ROLES) expect(canInvite(HOST_ROLE, r)).toBe(false);
  });

  it("is never changed to another role; managers and owners may remove host users", () => {
    const host = { userId: "h", role: HOST_ROLE };
    for (const actor of ["owner", "manager"] as const) {
      for (const to of ROLES)
        expect(canChangeRole({ userId: "a", role: actor }, host, to)).toBe(
          false,
        );
      expect(canRemove({ userId: "a", role: actor }, host)).toBe(true);
    }
    for (const actor of ["technician", "viewer", HOST_ROLE] as const)
      expect(canRemove({ userId: "a", role: actor }, host)).toBe(false);
    // A host user manages nobody.
    expect(canRemove(host, { userId: "v", role: "viewer" })).toBe(false);
  });
});

describe("what a host user may do", () => {
  it("can change nothing with every switch off", () => {
    const m = hostUser();
    for (const action of ACTIONS)
      for (const site of [SITE_A, SITE_A2, SITE_B, OWN_SITE, null, undefined])
        expect(may(m, action, site)).toBe(false);
    expect(anyCommand(commandRights(m, SITE_A))).toBe(false);
    // Reading their own network is always on.
    expect(readsNetwork(m)).toBe(true);
  });

  it("acts only on the host's own sites, and only with that action's switch", () => {
    const m = hostUser(ALL_ON);
    for (const action of [
      "start",
      "stop",
      "reset",
      "unlock",
      "prices",
    ] as const) {
      expect(may(m, action, SITE_A)).toBe(true);
      expect(may(m, action, SITE_A2)).toBe(true);
      // Another host's site, the operator's own, or no site at all: never.
      expect(may(m, action, SITE_B)).toBe(false);
      expect(may(m, action, OWN_SITE)).toBe(false);
      expect(may(m, action, null)).toBe(false);
      expect(may(m, action, undefined)).toBe(false);
    }
    expect(may(m, "invite")).toBe(true);
    // Managing hosts is never a host user's.
    expect(may(m, "hosts", SITE_A)).toBe(false);
  });

  it("maps each switch to its actions only", () => {
    for (const p of HOST_PERMISSIONS) {
      const m = hostUser({ ...NO_PERMISSIONS, [p]: true });
      for (const action of ACTIONS)
        expect(may(m, action, SITE_A)).toBe(permissionFor(action) === p);
    }
    expect(permissionFor("hosts")).toBeNull();
    // Fault emails allow no action in the app.
    const faults = hostUser({ ...NO_PERMISSIONS, faultEmails: true });
    expect(ACTIONS.some((a) => may(faults, a, SITE_A))).toBe(false);
  });

  it("has no access at all without a host (archived or missing)", () => {
    const m: Member = { role: HOST_ROLE, host: null };
    expect(readsNetwork(m)).toBe(false);
    for (const action of ACTIONS) expect(may(m, action, SITE_A)).toBe(false);
    expect(modulesFor(m, { fleet: true })).toEqual([]);
  });

  it("keeps the operator roles as before", () => {
    const rules: Record<NetworkAction, (typeof ROLES)[number]> = {
      start: "technician",
      stop: "technician",
      reset: "technician",
      unlock: "technician",
      prices: "manager",
      invite: "manager",
      hosts: "manager",
    };
    for (const role of ROLES) {
      expect(readsNetwork(staff(role))).toBe(true);
      for (const action of ACTIONS)
        for (const site of [SITE_A, SITE_B, OWN_SITE, null])
          expect(may(staff(role), action, site)).toBe(
            atLeast(role, rules[action]),
          );
    }
  });

  it("shows a host user only their sections, and Pricing and Team with their switches", () => {
    const slugs = (p = NO_PERMISSIONS) =>
      modulesFor(hostUser(p), { fleet: true }).map((m) => m.slug);
    expect(slugs()).toEqual(["overview", "chargers", "live", "reports"]);
    expect(slugs({ ...NO_PERMISSIONS, editPrices: true })).toContain("pricing");
    expect(slugs({ ...NO_PERMISSIONS, invite: true })).toContain("team");
    expect(slugs(ALL_ON)).not.toContain("hosts");
    expect(slugs(ALL_ON)).not.toContain("settings");
    expect(slugs(ALL_ON)).not.toContain("cards");
    expect(
      modulesFor(staff("viewer"), { fleet: false }).map((m) => m.slug),
    ).toContain("hosts");
  });
});

describe("the host filter", () => {
  it("reads every site, the operator's own, or one host; anything else is every site", () => {
    expect(parseHostFilter(undefined)).toEqual({ kind: "all" });
    expect(parseHostFilter("own")).toEqual({ kind: "own" });
    expect(parseHostFilter("demo-host-a")).toEqual({
      kind: "host",
      hostId: "demo-host-a",
    });
    const id = "6f1c3c1e-0b7a-4c55-9a3e-2f1d4e5a6b7c";
    expect(parseHostFilter([id.toUpperCase()])).toEqual({
      kind: "host",
      hostId: id,
    });
    for (const bad of ["", "x", "1; drop", "../own", "demo-host-A!"])
      expect(parseHostFilter(bad)).toEqual({ kind: "all" });
    expect(hostFilterParam({ kind: "all" })).toBe("");
    expect(hostFilterParam({ kind: "own" })).toBe("own");
  });

  it("scopes to one host's sites, or to the sites of no host", () => {
    const sites = [
      { locationId: SITE_A, hostId: "demo-host-a" },
      { locationId: SITE_B, hostId: "demo-host-b" },
    ];
    expect(filterScope({ kind: "all" }, sites)).toBeNull();
    const a = filterScope({ kind: "host", hostId: "demo-host-a" }, sites)!;
    expect([SITE_A, SITE_B, OWN_SITE].map(a.allows)).toEqual([
      true,
      false,
      false,
    ]);
    const own = filterScope({ kind: "own" }, sites)!;
    expect([SITE_A, SITE_B, OWN_SITE, null].map(own.allows)).toEqual([
      false,
      false,
      true,
      true,
    ]);
    // A host with no sites sees none.
    const none = filterScope({ kind: "host", hostId: "demo-host-c" }, sites)!;
    expect([SITE_A, SITE_B, OWN_SITE, null].some(none.allows)).toBe(false);
  });
});

// ---- The scoped client ----

const station = (id: number, location_id: number | null): Station => ({
  id,
  name: `DEMO-${id}`,
  online: true,
  location_id,
  connectors: [{ id: id * 10 + 1, number: 1, status: "Available" }],
});

const STATIONS = [
  station(1, SITE_A),
  station(2, SITE_A2),
  station(3, SITE_B),
  station(4, OWN_SITE),
  station(5, null),
];

function fakeIvora() {
  const notFound = () => new IvoraError(404, "station_not_found", "No.");
  const inner = {
    mode: "demo" as const,
    listLocations: vi.fn(async () =>
      [SITE_A, SITE_A2, SITE_B, OWN_SITE].map((id) => ({ id, name: `S${id}` })),
    ),
    listAllLocations: vi.fn(async () => ({
      data: [SITE_A, SITE_A2, SITE_B, OWN_SITE].map((id) => ({
        id,
        name: `S${id}`,
      })),
      truncated: false,
    })),
    listStations: vi.fn(async () => STATIONS),
    listAllStations: vi.fn(async () => ({ data: STATIONS, truncated: false })),
    getStation: vi.fn(async (id: number) => {
      const s = STATIONS.find((x) => x.id === id);
      if (!s) throw notFound();
      return s;
    }),
    sendCommand: vi.fn(async () => ({ id: "op", status: "pending" })),
    getOperation: vi.fn(async () => ({ id: "op", status: "succeeded" })),
    listFaults: vi.fn(async () => []),
    listTransactions: vi.fn(async () =>
      STATIONS.map((s) => ({ id: s.id * 100, station_id: s.id })),
    ),
    listTransactionsAfter: vi.fn(async () => ({ data: [], next: null })),
    listSessions: vi.fn(async () => ({
      data: STATIONS.map((s) => ({ id: s.id * 100, station_id: s.id })),
      next_cursor: null,
    })),
    listBills: vi.fn(async () => ({
      data: STATIONS.map((s) => ({ id: `bill-${s.id}`, station_id: s.id })),
      next_cursor: null,
    })),
    getTransaction: vi.fn(async (id: number) => ({
      id,
      station_id: id / 100,
    })),
    getStats: vi.fn(async () => ({})),
    getPaymentAccount: vi.fn(async () => ({})),
    listAllTokens: vi.fn(async () => ({ data: [], truncated: false })),
    getOcpiSettings: vi.fn(async () => ({})),
    findToken: vi.fn(async () => null),
    createToken: vi.fn(async () => ({ id: 1 })),
    deleteStation: vi.fn(async () => undefined),
  };
  return { inner, client: inner as unknown as IvoraClient };
}

const ids = (l: { id: number }[]) => l.map((x) => x.id);

describe("the scoped Ivora client (host users)", () => {
  const scope = sitesScope([SITE_A, SITE_A2]);

  it("lists only the host's sites and chargers", async () => {
    const { client } = fakeIvora();
    const c = scopedIvora(client, scope, true);
    expect(ids((await c.listAllLocations()).data)).toEqual([SITE_A, SITE_A2]);
    expect(ids(await c.listLocations())).toEqual([SITE_A, SITE_A2]);
    expect(ids((await c.listAllStations()).data)).toEqual([1, 2]);
    expect(ids(await c.listStations())).toEqual([1, 2]);
  });

  it("answers 404 for another host's or the operator's charger, and sends nothing to it", async () => {
    const { client, inner } = fakeIvora();
    const c = scopedIvora(client, scope, true);
    expect((await c.getStation(1)).id).toBe(1);
    for (const id of [3, 4, 5]) {
      await expect(c.getStation(id)).rejects.toMatchObject({ status: 404 });
      await expect(
        c.sendCommand(id, { action: "reset", mode: "soft" } as never, "k"),
      ).rejects.toMatchObject({ status: 404 });
      await expect(c.listFaults(id)).rejects.toMatchObject({ status: 404 });
      await expect(
        c.listTransactions({ station_id: id }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        c.listTransactionsAfter({ station_id: id, after: 0 }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(c.listSessions({ station_id: id })).rejects.toMatchObject({
        status: 404,
      });
      await expect(c.listBills({ station_id: id })).rejects.toMatchObject({
        status: 404,
      });
      // 403, not 404: a 404 would make session tracking forget the session.
      await expect(c.getTransaction(id * 100)).rejects.toMatchObject({
        status: 403,
      });
    }
    expect(inner.sendCommand).not.toHaveBeenCalled();
    expect(inner.listFaults).not.toHaveBeenCalled();
    await c.sendCommand(2, { action: "reset", mode: "soft" } as never, "k");
    expect(inner.sendCommand).toHaveBeenCalledTimes(1);
  });

  it("never makes session tracking forget another host's session", async () => {
    const { client } = fakeIvora();
    const c = scopedIvora(client, scope, true);
    const store = {
      trackSession: vi.fn(async () => undefined),
      forgetSession: vi.fn(async () => undefined),
    };
    await expect(
      trackTransactionById({ store, ivora: c }, 300),
    ).rejects.toMatchObject({ status: 403 });
    expect(store.forgetSession).not.toHaveBeenCalled();
    expect(store.trackSession).not.toHaveBeenCalled();
  });

  it("filters the project-wide lists to the host's chargers", async () => {
    const { client } = fakeIvora();
    const c = scopedIvora(client, scope, true);
    expect((await c.listSessions({})).data.map((t) => t.station_id)).toEqual([
      1, 2,
    ]);
    expect((await c.listBills({})).data.map((b) => b.station_id)).toEqual([
      1, 2,
    ]);
    expect((await c.listTransactions()).map((t) => t.station_id)).toEqual([
      1, 2,
    ]);
  });

  it("refuses everything not written for hosts: project figures, payouts, cards, roaming, deletes", async () => {
    const { client, inner } = fakeIvora();
    const c = scopedIvora(client, scope, true);
    for (const call of [
      () => c.getStats({} as never),
      () => c.getPaymentAccount(),
      () => c.listAllTokens(),
      () => c.getOcpiSettings(),
      () => c.deleteStation(1, "k"),
    ])
      await expect(call()).rejects.toMatchObject({
        status: 403,
        code: "not_in_scope",
      });
    expect(inner.getStats).not.toHaveBeenCalled();
    expect(inner.deleteStation).not.toHaveBeenCalled();
    // An operation of their own command and the staff token for a remote start pass.
    await c.getOperation("op");
    await c.findToken("cpo-staff-op");
    expect(inner.getOperation).toHaveBeenCalled();
  });

  it("an operator's filter narrows lists and lets everything else through", async () => {
    const { client, inner } = fakeIvora();
    const c = scopedIvora(client, sitesScope([SITE_B]), false);
    expect(ids((await c.listAllStations()).data)).toEqual([3]);
    await c.getStats({} as never);
    expect(inner.getStats).toHaveBeenCalled();
  });

  it("is applied to a host user's dependencies whatever the caller passed", async () => {
    const { client } = fakeIvora();
    const d = { ivora: client };
    const host = hostUser();
    expect(staffScope(staff("owner"))).toBeNull();
    expect(forStaff(d, staff("owner"))).toBe(d);
    const scoped = forStaff(d, host);
    expect(ids((await scoped.ivora.listAllStations()).data)).toEqual([1, 2]);
    // Not wrapped twice.
    expect(forStaff(scoped, host)).toBe(scoped);
    // A filter never widens a host user's view: their own scope wins.
    const { d: n } = narrow(d, host, sitesScope([SITE_B]));
    expect(ids((await n.ivora.listAllStations()).data)).toEqual([1, 2]);
    // A host user with no host (should not happen) sees nothing.
    const { d: none } = narrow(d, { ...host, host: null });
    expect((await none.ivora.listAllStations()).data).toEqual([]);
  });
});
