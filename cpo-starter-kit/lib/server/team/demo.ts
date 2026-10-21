import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { leavesNoOwner, ROLES } from "@/lib/roles";
import {
  invalidInvite,
  lastOwner,
  TeamError,
  type InviteRecord,
  type Member,
  type Staff,
  type TeamBackend,
} from "./types";

// Demo team: a labelled sample team that each visitor can change. Its state lives in
// that visitor's own cookie (see demo-cookie.ts), so visitors never see each other's
// changes and nothing is sent anywhere.

export const DEMO_OPERATOR_ID = "demo-operator";
export const DEMO_OWNER_ID = "00000000-0000-4000-8000-00000000d000";
const MAX_MEMBERS = 12;
const MAX_INVITES = 8;
const MAX_COOKIE_CHARS = 3800;

const role = z.enum(ROLES);
const stateSchema = z.object({
  v: z.literal(1),
  members: z
    .array(
      z.object({
        userId: z.string().max(64),
        email: z.string().max(254),
        role,
        createdAt: z.string().max(40),
      }),
    )
    .max(MAX_MEMBERS),
  invites: z
    .array(
      z.object({
        id: z.string().max(64),
        email: z.string().max(254),
        role,
        tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
        expiresAt: z.string().max(40),
        state: z.enum(["pending", "accepted", "revoked"]),
      }),
    )
    .max(MAX_INVITES),
});
export type DemoTeamState = z.infer<typeof stateSchema>;

const SEEDED = "2026-01-01T00:00:00.000Z";

export function demoSeed(): DemoTeamState {
  return {
    v: 1,
    members: [
      {
        userId: DEMO_OWNER_ID,
        email: "demo-owner@example.com",
        role: "owner",
        createdAt: SEEDED,
      },
      {
        userId: "00000000-0000-4000-8000-00000000d001",
        email: "sample-manager@example.com",
        role: "manager",
        createdAt: SEEDED,
      },
      {
        userId: "00000000-0000-4000-8000-00000000d002",
        email: "sample-technician@example.com",
        role: "technician",
        createdAt: SEEDED,
      },
      {
        userId: "00000000-0000-4000-8000-00000000d003",
        email: "sample-viewer@example.com",
        role: "viewer",
        createdAt: SEEDED,
      },
    ],
    invites: [],
  };
}

/** Decode a stored state, falling back to the seed for anything unreadable. */
export function decodeDemoState(raw: string | undefined): DemoTeamState {
  if (!raw) return demoSeed();
  try {
    const parsed = stateSchema.safeParse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : demoSeed();
  } catch {
    return demoSeed();
  }
}

export function encodeDemoState(s: DemoTeamState): string {
  return Buffer.from(JSON.stringify(s), "utf8").toString("base64url");
}

export interface DemoStore {
  load(): Promise<DemoTeamState>;
  save(s: DemoTeamState): Promise<void>;
}

export function memoryDemoStore(initial = demoSeed()): DemoStore & {
  state: DemoTeamState;
} {
  const store = {
    state: structuredClone(initial),
    async load() {
      return structuredClone(store.state);
    },
    async save(s: DemoTeamState) {
      store.state = structuredClone(s);
    },
  };
  return store;
}

export function createDemoBackend(
  store: DemoStore,
  operatorName: string,
  now = () => new Date(),
): TeamBackend {
  const live = (i: DemoTeamState["invites"][number]) =>
    i.state === "pending" && Date.parse(i.expiresAt) > now().getTime();
  const save = async (s: DemoTeamState) => {
    // A cookie holds about 4 KB.
    if (encodeDemoState(s).length > MAX_COOKIE_CHARS)
      throw new TeamError(
        "demo_full",
        "The demo team is full. Remove someone, revoke an invite or reset the demo.",
      );
    await store.save(s);
  };

  return {
    mode: "demo",
    async staffForUser(userId) {
      const m = (await store.load()).members.find((x) => x.userId === userId);
      if (!m) return null;
      const staff: Staff = {
        userId: m.userId,
        email: m.email,
        role: m.role,
        operatorId: DEMO_OPERATOR_ID,
        operatorName,
        demo: true,
      };
      return staff;
    },
    async isStaffEmail(email) {
      return (await store.load()).members.some((m) => m.email === email);
    },
    async members() {
      return (await store.load()).members.map((m): Member => ({ ...m }));
    },
    async pendingInvites() {
      return (await store.load()).invites
        .filter(live)
        .map(({ id, email, role, expiresAt }) => ({
          id,
          email,
          role,
          expiresAt,
        }));
    },
    async createInvite(i) {
      const s = await store.load();
      if (s.members.some((m) => m.email === i.email))
        throw new TeamError(
          "already_staff",
          "This person is already on the team.",
        );
      // Like the database: a new invite replaces a pending one for the same email.
      s.invites = s.invites.filter((x) => live(x) && x.email !== i.email);
      if (s.invites.length >= MAX_INVITES)
        throw new TeamError(
          "demo_full",
          "The demo holds up to 8 pending invites. Revoke one or reset the demo.",
        );
      const id = randomUUID();
      s.invites.push({
        id,
        email: i.email,
        role: i.role,
        tokenHash: i.tokenHash,
        expiresAt: i.expiresAt.toISOString(),
        state: "pending",
      });
      await save(s);
      return id;
    },
    async revokeInvite(_operatorId, inviteId) {
      const s = await store.load();
      const inv = s.invites.find((x) => x.id === inviteId && live(x));
      if (!inv) return false;
      s.invites = s.invites.filter((x) => x !== inv);
      await save(s);
      return true;
    },
    async findInvite(tokenHash) {
      const inv = (await store.load()).invites.find(
        (x) => x.tokenHash === tokenHash,
      );
      if (!inv) return null;
      const r: InviteRecord = {
        id: inv.id,
        email: inv.email,
        role: inv.role,
        expiresAt: inv.expiresAt,
        state: inv.state,
        operatorId: DEMO_OPERATOR_ID,
        operatorName,
      };
      return r;
    },
    async acceptInvite(tokenHash, userId, email) {
      const s = await store.load();
      const inv = s.invites.find(
        (x) => x.tokenHash === tokenHash && x.email === email && live(x),
      );
      if (!inv) throw invalidInvite();
      if (s.members.length >= MAX_MEMBERS)
        throw new TeamError(
          "demo_full",
          "The demo team is full. Remove someone or reset the demo.",
        );
      s.invites = s.invites.filter((x) => x !== inv);
      s.members.push({
        userId,
        email,
        role: inv.role,
        createdAt: now().toISOString(),
      });
      await save(s);
    },
    async setRole(_operatorId, userId, to) {
      const s = await store.load();
      const m = s.members.find((x) => x.userId === userId);
      if (!m)
        throw new TeamError("not_found", "This person is not on the team.");
      if (leavesNoOwner(s.members, userId, to)) throw lastOwner();
      m.role = to;
      await save(s);
    },
    async removeMember(_operatorId, userId) {
      const s = await store.load();
      if (leavesNoOwner(s.members, userId, null)) throw lastOwner();
      s.members = s.members.filter((x) => x.userId !== userId);
      await save(s);
    },
    async hasStaff() {
      return true;
    },
    async bootstrapOwner() {
      throw new TeamError("setup_done", "The demo team is already set up.");
    },
  };
}
