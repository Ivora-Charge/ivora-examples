import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Network mode, end to end in demo mode: a host user reads and acts only on their own
// host's sites through every route family (pages' services, server actions, route
// handlers), deep links to anything else answer 404, every switch off means no
// change, and removing a host user or archiving a host ends their access at once.
// Next.js request APIs are replaced for plain Node: a cookie jar (the demo state lives
// in cookies), and redirect/notFound that throw like Next.js does.

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { name, value: jar.get(name)! } : undefined,
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  unstable_rethrow: (e: unknown) => {
    if (e instanceof Error && e.message.startsWith("NEXT_")) throw e;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { NO_PERMISSIONS } from "@/lib/hosts";
import { HOST_ROLE } from "@/lib/roles";
import {
  currentStaff,
  requireNetworkReader,
  requireRole,
} from "@/lib/server/auth";
import { getChargers, loadCharger, loadChargers } from "@/lib/server/chargers";
import {
  archiveHost,
  assignSite,
  getHosts,
  loadHosts,
  saveHost,
} from "@/lib/server/hosts";
import { DEMO_HOST_A, DEMO_HOST_B } from "@/lib/server/hosts/demo";
import { setDemoViewAs } from "@/lib/server/hosts/demo-cookie";
import { resetIvoraForTests } from "@/lib/server/ivora";
import {
  getLive,
  loadLive,
  loadStation,
  recheckCommand,
  sendCommand,
} from "@/lib/server/live";
import { resetDemoLiveForTests } from "@/lib/server/live/demo-cookie";
import { loadOverview } from "@/lib/server/overview";
import {
  getPricing,
  loadPricing,
  setStationPricing,
} from "@/lib/server/pricing";
import {
  getReports,
  loadReportsContext,
  reportFilter,
} from "@/lib/server/reports";
import { resetDemoCheckoutForTests } from "@/lib/server/checkout/demo-cookie";
import { getTeam, inviteStaff, loadTeam, removeStaff } from "@/lib/server/team";
import {
  DEMO_HOST_USER_A,
  DEMO_HOST_USER_B,
  DEMO_OWNER_ID,
} from "@/lib/server/team/demo";
import type { Staff } from "@/lib/server/team/types";

const VARS = [
  "IVORA_API_KEY",
  "IVORA_TENANT_ID",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "RESEND_API_KEY",
  "EMAIL_FROM",
];

// Demo network: host A has sites 9001 and 9002 (chargers 9101, 9102, 9103) with
// "restart and unlock" and "start and stop" on; host B has 9003 and 9004 (chargers
// 9104, 9105) with every switch off.
const A_CHARGERS = ["DEMO-HARBOUR-01", "DEMO-HARBOUR-02", "DEMO-MARKET-01"];
const B_CHARGERS = ["DEMO-RIVERSIDE-01", "DEMO-WATERFRONT-01"];

async function as(userId: string | null): Promise<Staff> {
  await setDemoViewAs(userId);
  const s = await currentStaff();
  if (!s) throw new Error("not signed in");
  return s;
}
const owner = () => as(null);
const hostA = () => as(DEMO_HOST_USER_A);
const hostB = () => as(DEMO_HOST_USER_B);

const names = (l: { name: string }[]) => l.map((x) => x.name).sort();

/** Saves host A's switches as the demo owner. */
async function switches(hostId: string, on: Partial<typeof NO_PERMISSIONS>) {
  const me = await owner();
  const d = await getHosts();
  const h = (await d.store.list(me.operatorId)).find((x) => x.id === hostId)!;
  const p = { ...NO_PERMISSIONS, ...on };
  await saveHost(d, me, hostId, {
    name: h.name,
    ...Object.fromEntries(
      Object.entries(p).map(([k, v]) => [k, v ? "on" : ""]),
    ),
  });
}

describe("network mode: host users in demo mode", () => {
  const saved = { ...process.env };
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    for (const k of VARS) delete process.env[k];
    process.env.DEMO_MODE = "true";
    jar.clear();
    resetIvoraForTests();
    resetDemoLiveForTests();
    resetDemoCheckoutForTests();
    fetchSpy = vi.fn(() => {
      throw new Error("demo mode must not call fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  describe("sign-in and pages", () => {
    it("views the app as a sample host user only through the demo view, and back", async () => {
      const a = await hostA();
      expect(a).toMatchObject({ role: HOST_ROLE, demo: true });
      expect(a.host).toMatchObject({ id: DEMO_HOST_A, siteIds: [9001, 9002] });
      // Operator-only pages and actions answer 404 to a host user.
      await expect(requireRole("viewer")).rejects.toThrow("NEXT_NOT_FOUND");
      await expect(requireNetworkReader()).resolves.toMatchObject({
        role: HOST_ROLE,
      });
      // The view cookie is only honoured for a host user of the visitor's demo team.
      expect((await as(DEMO_OWNER_ID)).role).toBe("owner");
      expect((await as("00000000-0000-4000-8000-00000000d001")).role).toBe(
        "owner",
      );
      expect((await owner()).role).toBe("owner");
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("Chargers", () => {
    it("lists only the host's chargers; another host's charger answers 404", async () => {
      const a = await hostA();
      const r = await loadChargers(getChargers(), a);
      if (!r.ok) throw new Error(r.error);
      expect(names(r.chargers)).toEqual(A_CHARGERS);
      expect(r.sites.map((s) => s.id).sort()).toEqual([9001, 9002]);
      // Deep links to host B's or nobody's charger: not found (the page then 404s).
      for (const key of ["station-9104", "station-9105", "station-424242"]) {
        const one = await loadCharger(getChargers(), a, key);
        expect(one.ok && one.charger).toBeNull();
      }
      const b = await hostB();
      const rb = await loadChargers(getChargers(), b);
      expect(rb.ok && names(rb.chargers)).toEqual(B_CHARGERS);
    });

    it("lets operator staff filter by host, and still see every site without a filter", async () => {
      const me = await owner();
      const all = await loadChargers(getChargers(), me);
      expect(all.ok && all.chargers.length).toBe(5);
    });
  });

  describe("Live", () => {
    it("shows only the host's sites, sessions and faults", async () => {
      const a = await hostA();
      const r = await loadLive(getLive(), a);
      if (!r.ok) throw new Error(r.error);
      expect(r.live.sites.map((s) => s.id).sort()).toEqual([9001, 9002]);
      expect(
        r.live.sessions.every((s) => [9101, 9102, 9103].includes(s.stationId)),
      ).toBe(true);
      expect(
        r.live.faults.every((f) => [9101, 9102, 9103].includes(f.stationId)),
      ).toBe(true);
      const b = await hostB();
      const rb = await loadLive(getLive(), b);
      expect(rb.ok && rb.live.faults).toEqual([]);
      expect(rb.ok && rb.live.sessions).toEqual([]);
    });

    it("answers 404 for another host's charger page", async () => {
      const a = await hostA();
      for (const id of [9104, 9105]) {
        const r = await loadStation(getLive(), a, id);
        expect(r.ok && r.detail).toBeNull();
      }
      const own = await loadStation(getLive(), a, 9101);
      expect(own.ok && own.detail?.station.id).toBe(9101);
    });

    it("can change nothing with every switch off (host B)", async () => {
      const b = await hostB();
      for (const [action, extra] of [
        ["reset", { mode: "soft" }],
        ["unlock", { connectorId: "91051" }],
        ["start", { connectorId: "91051" }],
      ] as const)
        await expect(
          sendCommand(getLive(), b, {
            requestId: crypto.randomUUID(),
            stationId: "9105",
            action,
            ...extra,
            confirmed: true,
            sessions: [],
          }),
        ).rejects.toMatchObject({ code: "not_allowed" });
      expect((await getLive().store.listCommands("demo-operator")).length).toBe(
        0,
      );
    });

    it("sends a switched-on command on the host's own charger, never on another's", async () => {
      const a = await hostA();
      const c = await sendCommand(getLive(), a, {
        requestId: crypto.randomUUID(),
        stationId: "9101",
        action: "reset",
        mode: "soft",
        confirmed: true,
        sessions: [],
      });
      expect(c).toMatchObject({ stationId: 9101, action: "reset" });
      // Host B's charger, with host A's switch on: 404, nothing claimed or sent.
      await expect(
        sendCommand(getLive(), a, {
          requestId: crypto.randomUUID(),
          stationId: "9104",
          action: "reset",
          mode: "soft",
          confirmed: true,
          sessions: [],
        }),
      ).rejects.toMatchObject({ status: 404 });
      const commands = await getLive().store.listCommands("demo-operator");
      expect(commands.map((x) => x.stationId)).toEqual([9101]);
      // Host B can't check host A's command, even knowing its ID.
      await switches(DEMO_HOST_B, { control: true });
      const b = await hostB();
      await expect(recheckCommand(getLive(), b, c.id)).rejects.toMatchObject({
        status: 404,
      });
      // And host A's own command list in Live has only its chargers'.
      const live = await loadLive(getLive(), b);
      expect(live.ok && live.live.commands).toEqual([]);
    });

    it("ends a switch at once: turned off, the next command is refused", async () => {
      await switches(DEMO_HOST_A, {});
      const a = await hostA();
      await expect(
        sendCommand(getLive(), a, {
          requestId: crypto.randomUUID(),
          stationId: "9101",
          action: "reset",
          mode: "soft",
          confirmed: true,
          sessions: [],
        }),
      ).rejects.toMatchObject({ code: "not_allowed" });
    });

    it("refuses the server action to a host user without the switch", async () => {
      const { sendCommandAction } = await import("@/app/(staff)/live/actions");
      await hostB();
      const form = new FormData();
      for (const [k, v] of Object.entries({
        requestId: crypto.randomUUID(),
        stationId: "9105",
        action: "reset",
        mode: "soft",
        confirm: "on",
      }))
        form.set(k, v);
      const r = await sendCommandAction({}, form);
      expect(r.error).toMatch(/role can't|not allowed|can't/i);
    });

    it("lets the live-changes route answer a host user", async () => {
      const { GET } = await import("@/app/api/live/changes/route");
      await hostA();
      const res = await GET();
      expect(res.status).toBe(200);
    });
  });

  describe("Reports", () => {
    it("limits the report to the host's chargers, and a charger of another host is 404", async () => {
      const a = await hostA();
      const r = await loadReportsContext(getReports(), a, {
        get: () => null,
      });
      if (!r.ok) throw new Error(r.error);
      expect(r.context.hostView).toBe(true);
      expect(r.context.stations.map((s) => s.name).sort()).toEqual(A_CHARGERS);
      expect(r.context.stationIds?.sort()).toEqual([9101, 9102, 9103]);
      expect(reportFilter(a, r.context).stationIds?.sort()).toEqual([
        9101, 9102, 9103,
      ]);
      // Even a caller that forgot the scope gets none of the operator's.
      expect(
        reportFilter(a, { query: r.context.query, stationIds: null })
          .stationIds,
      ).toEqual([]);
      const other = await loadReportsContext(getReports(), a, {
        get: (k) => (k === "station" ? "9104" : null),
      });
      expect(other.ok && other.context.unknownStation).toBe(true);
    });

    it("exports only the host's own sessions; another host's charger is 404", async () => {
      const { GET } = await import("@/app/(staff)/reports/export/route");
      await hostB();
      const mine = await GET(
        new Request("http://localhost/reports/export?period=90d"),
      );
      expect(mine.status).toBe(200);
      const text = await mine.text();
      for (const n of A_CHARGERS) expect(text).not.toContain(n);
      const theirs = await GET(
        new Request("http://localhost/reports/export?station=9101"),
      );
      expect(theirs.status).toBe(404);
    });
  });

  describe("Overview", () => {
    it("counts only the host's sites and chargers", async () => {
      const r = await loadOverview(await hostA());
      if (!r.ok) throw new Error(r.error);
      expect(r.overview).toMatchObject({ sites: 2, chargers: 3 });
      expect(names(r.overview.stations)).toEqual(A_CHARGERS);
    });
  });

  describe("Pricing", () => {
    it("is refused without the switch, and with it only for the host's own chargers", async () => {
      const save = async (who: Staff, stationId: string) =>
        setStationPricing(getPricing(), who, {
          stationId,
          revision: "0",
          private: true,
        });
      await expect(
        loadPricing(getPricing(), await hostA()),
      ).rejects.toMatchObject({ code: "not_allowed" });
      await expect(save(await hostA(), "9101")).rejects.toMatchObject({
        code: "not_allowed",
      });
      await switches(DEMO_HOST_A, { editPrices: true });
      const a = await hostA();
      await expect(save(a, "9104")).rejects.toMatchObject({
        code: "not_found",
      });
      const before = await loadPricing(getPricing(), a);
      await setStationPricing(getPricing(), a, {
        stationId: "9101",
        revision: String(
          before.stations.find((s) => s.stationId === 9101)!.revision,
        ),
        private: true,
      });
      const view = await loadPricing(getPricing(), a);
      expect(names(view.stations)).toEqual(A_CHARGERS);
      expect(view.stations.find((s) => s.stationId === 9101)?.private).toBe(
        true,
      );
    });
  });

  describe("Team", () => {
    it("lets a host user invite only for their own host, and only with the switch", async () => {
      await expect(
        inviteStaff(getTeam(), await hostA(), {
          email: "colleague@example.com",
          role: "host",
        }),
      ).rejects.toMatchObject({ code: "not_allowed" });
      await switches(DEMO_HOST_A, { invite: true });
      const a = await hostA();
      // Asking for an operator role or another host still invites for their own.
      const r = await inviteStaff(getTeam(), a, {
        email: "colleague@example.com",
        role: "owner",
        hostId: DEMO_HOST_B,
      });
      expect(r.role).toBe(HOST_ROLE);
      const t = await loadTeam(getTeam(), a);
      expect(t.members.map((m) => m.email)).toEqual([
        "sample-host-a@example.com",
      ]);
      expect(t.invites).toMatchObject([
        {
          email: "colleague@example.com",
          role: HOST_ROLE,
          hostId: DEMO_HOST_A,
        },
      ]);
    });

    it("gives a host user one generic refusal for anyone outside their host, and leaves them untouched", async () => {
      const me = await owner();
      await inviteStaff(getTeam(), me, {
        email: "pending-staff@example.com",
        role: "viewer",
      });
      await inviteStaff(getTeam(), me, {
        email: "pending-b@example.com",
        role: "host",
        hostId: DEMO_HOST_B,
      });
      await switches(DEMO_HOST_A, { invite: true });
      const before = await loadTeam(getTeam(), await owner());
      const a = await hostA();
      const refusals: unknown[] = [];
      for (const email of [
        "pending-staff@example.com", // the owner's pending staff invite
        "pending-b@example.com", // host B's pending invite
        "sample-manager@example.com", // an operator member
        "sample-host-b@example.com", // a host B member
      ])
        refusals.push(
          await inviteStaff(getTeam(), a, { email, role: "host" }).then(
            () => "invited",
            (e: { code: string; message: string }) => ({
              code: e.code,
              message: e.message,
            }),
          ),
        );
      // The same answer every time: nothing shows which case it was.
      expect(new Set(refusals.map((r) => JSON.stringify(r))).size).toBe(1);
      expect(refusals[0]).toMatchObject({ code: "invite_refused" });
      expect((refusals[0] as { message: string }).message).not.toMatch(
        /team|pending|already|elsewhere/i,
      );
      // Nothing outside host A changed.
      const after = await loadTeam(getTeam(), await owner());
      expect(after.members).toEqual(before.members);
      expect(after.invites).toEqual(before.invites);
      // Their own host still works, and re-inviting replaces only that invite.
      await inviteStaff(getTeam(), await hostA(), {
        email: "own@example.com",
        role: "host",
      });
      await inviteStaff(getTeam(), await hostA(), {
        email: "own@example.com",
        role: "host",
      });
      const last = await loadTeam(getTeam(), await owner());
      expect(last.invites.filter((i) => i.email === "own@example.com")).toEqual(
        [expect.objectContaining({ hostId: DEMO_HOST_A })],
      );
      expect(last.invites.filter((i) => i.email !== "own@example.com")).toEqual(
        before.invites,
      );
    });

    it("lets owners invite a host user for an active host only", async () => {
      const me = await owner();
      await expect(
        inviteStaff(getTeam(), me, {
          email: "new-host@example.com",
          role: "host",
        }),
      ).rejects.toMatchObject({ code: "invalid" });
      const r = await inviteStaff(getTeam(), me, {
        email: "new-host@example.com",
        role: "host",
        hostId: DEMO_HOST_B,
      });
      expect(r.role).toBe(HOST_ROLE);
      const t = await loadTeam(getTeam(), me);
      expect(
        t.invites.find((i) => i.email === "new-host@example.com"),
      ).toMatchObject({
        hostId: DEMO_HOST_B,
      });
    });

    it("ends a removed host user's access at once", async () => {
      const me = await owner();
      await removeStaff(getTeam(), me, DEMO_HOST_USER_A);
      expect(await getTeam().backend.staffForUser(DEMO_HOST_USER_A)).toBeNull();
      // The view cookie no longer finds them: back to the demo owner.
      expect((await as(DEMO_HOST_USER_A)).role).toBe("owner");
    });
  });

  describe("Hosts", () => {
    it("is for owners and managers only", async () => {
      await expect(
        loadHosts(await getHosts(), await hostA()),
      ).rejects.toMatchObject({
        code: "not_allowed",
      });
      const viewer = {
        ...(await owner()),
        role: "viewer" as const,
      };
      await expect(loadHosts(await getHosts(), viewer)).rejects.toMatchObject({
        code: "not_allowed",
      });
      const r = await loadHosts(await getHosts(), await owner());
      expect(r.ok && r.sites.map((s) => [s.id, s.hostId])).toEqual([
        [9001, DEMO_HOST_A],
        [9002, DEMO_HOST_A],
        [9004, DEMO_HOST_B],
        [9003, DEMO_HOST_B],
      ]);
    });

    it("adds a host with every switch off", async () => {
      const me = await owner();
      const d = await getHosts();
      const id = await saveHost(d, me, null, {
        name: "Sample Host C",
        contactEmail: "Host-C@Example.com",
        editPrices: "",
      });
      const h = (await d.store.list(me.operatorId)).find((x) => x.id === id)!;
      expect(h).toMatchObject({
        name: "Sample Host C",
        contactEmail: "host-c@example.com",
        permissions: NO_PERMISSIONS,
      });
      await expect(
        saveHost(d, me, null, { name: "", contactEmail: "nope" }),
      ).rejects.toMatchObject({ code: "invalid" });
    });

    it("moves a site to another host, and refuses a site not in the project", async () => {
      const me = await owner();
      const d = await getHosts();
      await assignSite(d, me, "9002", DEMO_HOST_B);
      const b = await hostB();
      expect(b.host?.siteIds.sort()).toEqual([9002, 9003, 9004]);
      // Host A lost it at once.
      const a = await hostA();
      const r = await loadChargers(getChargers(), a);
      expect(r.ok && names(r.chargers)).toEqual([
        "DEMO-HARBOUR-01",
        "DEMO-HARBOUR-02",
      ]);
      await expect(
        assignSite(d, await owner(), "424242", DEMO_HOST_A),
      ).rejects.toMatchObject({ code: "not_found" });
      // Back to the operator: no host user sees it.
      await assignSite(d, await owner(), "9002", "");
      expect((await hostB()).host?.siteIds.sort()).toEqual([9003, 9004]);
    });

    it("archiving a host ends its users' access at once and gives its sites back", async () => {
      const me = await owner();
      const r = await archiveHost(await getHosts(), me, DEMO_HOST_B);
      expect(r.removedUsers).toBe(1);
      expect(await getTeam().backend.staffForUser(DEMO_HOST_USER_B)).toBeNull();
      expect((await as(DEMO_HOST_USER_B)).role).toBe("owner");
      const h = await loadHosts(await getHosts(), await owner());
      expect(h.ok && h.sites.filter((s) => s.hostId === DEMO_HOST_B)).toEqual(
        [],
      );
      // An archived host can't be changed or given sites.
      await expect(
        assignSite(await getHosts(), await owner(), "9003", DEMO_HOST_B),
      ).rejects.toMatchObject({ code: "not_found" });
    });

    it("refuses the Hosts actions to a host user (404)", async () => {
      const { saveHostAction } = await import("@/app/(staff)/hosts/actions");
      await hostA();
      const form = new FormData();
      form.set("name", "Sneaky");
      await expect(saveHostAction({}, form)).rejects.toThrow("NEXT_NOT_FOUND");
    });
  });

  describe("operator-only actions", () => {
    it("answer 404 to a host user: chargers, pricing editor, team changes, settings", async () => {
      const charger = await import("@/app/(staff)/chargers/actions");
      const pricing = await import("@/app/(staff)/pricing/actions");
      const team = await import("@/app/(staff)/team/actions");
      const roaming = await import("@/app/(staff)/settings/roaming/actions");
      await switches(DEMO_HOST_A, {
        editPrices: true,
        control: true,
        sessions: true,
        invite: true,
        faultEmails: true,
      });
      await hostA();
      const form = new FormData();
      form.set("key", "station-9101");
      form.set("userId", DEMO_OWNER_ID);
      for (const call of [
        () => charger.addChargerAction({}, form),
        () => charger.connectionTestAction({}, form),
        () => charger.removeChargerAction({}, form),
        () => pricing.saveTariffAction({}, form),
        () => team.removeAction({}, form),
        () => team.changeRoleAction({}, form),
        () => roaming.saveRoamingAction({}, form),
      ])
        await expect(call()).rejects.toThrow("NEXT_NOT_FOUND");
    });
  });
});
