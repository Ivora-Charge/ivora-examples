import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HOST_PERMISSIONS, NO_PERMISSIONS } from "@/lib/hosts";
import { atLeast } from "@/lib/roles";
import type { DemoStore as DemoTeamStore } from "../team/demo";
import {
  hostNotFound,
  hostsNotAllowed,
  HostError,
  type HostRecord,
  type HostStore,
  type SiteAssignment,
} from "./types";

// Demo hosts: a sample network with two fictional hosts, each with two of the sample
// sites. The visitor's own copy lives in their cookie (see demo-cookie.ts), so
// visitors never see each other's changes and nothing is sent anywhere.

export const DEMO_HOST_A = "demo-host-a";
export const DEMO_HOST_B = "demo-host-b";
const MAX_HOSTS = 8;
const MAX_COOKIE_CHARS = 3800;
const SEEDED = "2026-01-01T00:00:00.000Z";

const permissions = z.object(
  Object.fromEntries(HOST_PERMISSIONS.map((p) => [p, z.boolean()])) as Record<
    (typeof HOST_PERMISSIONS)[number],
    z.ZodBoolean
  >,
);
const stateSchema = z.object({
  v: z.literal(1),
  hosts: z
    .array(
      z.object({
        id: z.string().max(64),
        name: z.string().max(80),
        contactName: z.string().max(80).nullable(),
        contactEmail: z.string().max(254).nullable(),
        contactPhone: z.string().max(40).nullable(),
        permissions,
        createdAt: z.string().max(40),
        archivedAt: z.string().max(40).nullable(),
      }),
    )
    .max(MAX_HOSTS),
  sites: z
    .array(z.object({ locationId: z.number().int(), hostId: z.string() }))
    .max(64),
});
export type DemoHostState = z.infer<typeof stateSchema>;

export function demoHostSeed(): DemoHostState {
  return {
    v: 1,
    hosts: [
      {
        id: DEMO_HOST_A,
        name: "Sample Host A: Harbour Shops",
        contactName: "Sample Contact A",
        contactEmail: "host-a@example.com",
        contactPhone: "+1 555 0100",
        // One host with a few switches on, to show what they allow.
        permissions: { ...NO_PERMISSIONS, control: true, sessions: true },
        createdAt: SEEDED,
        archivedAt: null,
      },
      {
        id: DEMO_HOST_B,
        name: "Sample Host B: Riverside Hotel",
        contactName: "Sample Contact B",
        contactEmail: "host-b@example.com",
        contactPhone: "+1 555 0101",
        // Every switch off, as for a new host: its users can change nothing.
        permissions: { ...NO_PERMISSIONS },
        createdAt: SEEDED,
        archivedAt: null,
      },
    ],
    sites: [
      { locationId: 9001, hostId: DEMO_HOST_A },
      { locationId: 9002, hostId: DEMO_HOST_A },
      { locationId: 9003, hostId: DEMO_HOST_B },
      { locationId: 9004, hostId: DEMO_HOST_B },
    ],
  };
}

export function decodeDemoHosts(raw: string | undefined): DemoHostState {
  if (!raw) return demoHostSeed();
  try {
    const parsed = stateSchema.safeParse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : demoHostSeed();
  } catch {
    return demoHostSeed();
  }
}

export function encodeDemoHosts(s: DemoHostState): string {
  return Buffer.from(JSON.stringify(s), "utf8").toString("base64url");
}

export interface DemoHostStore {
  load(): Promise<DemoHostState>;
  save(s: DemoHostState): Promise<void>;
}

export function memoryDemoHosts(initial = demoHostSeed()): DemoHostStore & {
  state: DemoHostState;
} {
  const store = {
    state: structuredClone(initial),
    async load() {
      return structuredClone(store.state);
    },
    async save(s: DemoHostState) {
      store.state = structuredClone(s);
    },
  };
  return store;
}

/**
 * The demo host store. `team` is the demo team, so archiving a host removes its sample
 * users there, as the database does.
 */
export function createDemoHostStore(
  store: DemoHostStore,
  team: DemoTeamStore,
  now = () => new Date(),
): HostStore {
  const admin = (actor: { role: Parameters<typeof atLeast>[0] }) => {
    if (!atLeast(actor.role, "manager")) throw hostsNotAllowed();
  };
  const save = async (s: DemoHostState) => {
    if (encodeDemoHosts(s).length > MAX_COOKIE_CHARS)
      throw new HostError(
        "invalid",
        "The demo holds no more hosts. Archive one or reset the demo.",
      );
    await store.save(s);
  };
  return {
    mode: "demo",
    async list() {
      return (await store.load()).hosts
        .map((h): HostRecord => ({ ...h, permissions: { ...h.permissions } }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async sites() {
      return (await store.load()).sites.map((x): SiteAssignment => ({ ...x }));
    },
    async save(actor, id, input) {
      admin(actor);
      const s = await store.load();
      if (id === null) {
        if (s.hosts.length >= MAX_HOSTS)
          throw new HostError(
            "invalid",
            `The demo holds up to ${MAX_HOSTS} hosts. Reset the demo to start again.`,
          );
        const created = `demo-host-${randomUUID().slice(0, 8)}`;
        s.hosts.push({
          id: created,
          ...input,
          permissions: { ...input.permissions },
          createdAt: now().toISOString(),
          archivedAt: null,
        });
        await save(s);
        return created;
      }
      const h = s.hosts.find((x) => x.id === id && !x.archivedAt);
      if (!h) throw hostNotFound();
      Object.assign(h, input, { permissions: { ...input.permissions } });
      await save(s);
      return id;
    },
    async archive(actor, id) {
      admin(actor);
      const s = await store.load();
      const h = s.hosts.find((x) => x.id === id && !x.archivedAt);
      if (!h) throw hostNotFound();
      h.archivedAt = now().toISOString();
      s.sites = s.sites.filter((x) => x.hostId !== id);
      await save(s);
      const t = await team.load();
      const removed = t.members
        .filter((m) => m.hostId === id)
        .map((m) => m.userId);
      t.members = t.members.filter((m) => m.hostId !== id);
      t.invites = t.invites.filter((i) => i.hostId !== id);
      await team.save(t);
      return removed;
    },
    async assign(actor, locationId, hostId) {
      admin(actor);
      const s = await store.load();
      s.sites = s.sites.filter((x) => x.locationId !== locationId);
      if (hostId !== null) {
        if (!s.hosts.some((x) => x.id === hostId && !x.archivedAt))
          throw hostNotFound();
        s.sites.push({ locationId, hostId });
      }
      await save(s);
    },
    async faultRecipients() {
      // Demo mode sends no email.
      return [];
    },
  };
}
