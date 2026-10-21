import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { Role } from "@/lib/roles";
import { MailerError, type Email, type Mailer } from "@/lib/server/mail";
import { createMemoryLimiter, LIMITS } from "@/lib/server/rate-limit";
import {
  createDemoBackend,
  DEMO_OPERATOR_ID,
  DEMO_OWNER_ID,
  demoSeed,
  memoryDemoStore,
} from "@/lib/server/team/demo";
import {
  acceptStaffInvite,
  changeStaffRole,
  hashToken,
  inviteStaff,
  lookupInvite,
  removeStaff,
  requestSignInLink,
  revokeStaffInvite,
  setupOwner,
  signInWithPassword,
  type TeamDeps,
} from "@/lib/server/team/service";
import type { Accounts, Staff, TeamBackend } from "@/lib/server/team/types";

// The team rules run against the in-memory demo backend. "Live" cases reuse it with
// mode "live" and fake Supabase Auth accounts and mailer, so the live branches (email,
// logins, cleanup) are covered with no network and no real credentials.

const MANAGER_ID = "00000000-0000-4000-8000-00000000d001";
const TECH_ID = "00000000-0000-4000-8000-00000000d002";
const VIEWER_ID = "00000000-0000-4000-8000-00000000d003";
const NEW_USER = "00000000-0000-4000-8000-0000000000aa";
const PASSWORD = "correct horse battery";
const SETUP_SECRET = "setup-secret-for-tests-only";

let clock = new Date("2026-03-01T12:00:00Z");

function staff(userId: string, role: Role): Staff {
  return {
    userId,
    role,
    email: `${role}@example.com`,
    operatorId: DEMO_OPERATOR_ID,
    operatorName: "Sample Operator",
    demo: false,
  };
}
const owner = staff(DEMO_OWNER_ID, "owner");
const manager = staff(MANAGER_ID, "manager");
const technician = staff(TECH_ID, "technician");
const viewer = staff(VIEWER_ID, "viewer");

type FakeAccounts = { [K in keyof Accounts]: Mock<Accounts[K]> };

function fakeAccounts(): FakeAccounts {
  return {
    currentUser: vi.fn(
      async (): Promise<{ id: string; email: string } | null> => null,
    ),
    createUser: vi.fn(async (): Promise<string> => NEW_USER),
    deleteUser: vi.fn(async () => undefined),
    signInWithPassword: vi.fn(async (): Promise<string | null> => NEW_USER),
    sendSignInLink: vi.fn(async () => undefined),
    verifySignInLink: vi.fn(async () => true),
    exchangeCode: vi.fn(async () => true),
    signOut: vi.fn(async () => undefined),
  };
}

function setup(mode: "demo" | "live", o: { mailer?: Mailer | null } = {}) {
  const store = memoryDemoStore();
  const demo = createDemoBackend(store, "Sample Operator", () => clock);
  const backend: TeamBackend = mode === "demo" ? demo : { ...demo, mode };
  const accounts = fakeAccounts();
  const sent: { email: Email; key: string }[] = [];
  const mailer: Mailer = {
    send: vi.fn(async (email: Email, key: string) => {
      sent.push({ email, key });
    }),
  };
  const d: TeamDeps = {
    backend,
    accounts: mode === "demo" ? null : accounts,
    limiter: createMemoryLimiter(() => clock.getTime()),
    secret: "test-hmac-key",
    mailer: mode === "demo" ? null : o.mailer === undefined ? mailer : o.mailer,
    appUrl: "https://charge.example.com",
    setupSecret: SETUP_SECRET,
    now: () => clock,
  };
  return { d, store, accounts, sent, mailer };
}

const tokenOf = (link: string) => new URL(link).hash.slice(1);

describe("team service", () => {
  let logs: string[];
  beforeEach(() => {
    clock = new Date("2026-03-01T12:00:00Z");
    logs = [];
    for (const level of ["log", "info", "warn", "error"] as const)
      vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
        logs.push(JSON.stringify(a));
      });
    vi.stubGlobal("fetch", () => {
      throw new Error("tests must not reach the network");
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("invites", () => {
    it("emails a single-use link and stores only its hash", async () => {
      const { d, store, sent } = setup("live");
      const r = await inviteStaff(d, owner, {
        email: " New.Person@Example.com ",
        role: "technician",
      });
      expect(r).toMatchObject({
        email: "new.person@example.com",
        emailed: true,
        link: null,
      });
      expect(sent).toHaveLength(1);
      const link = sent[0].email.text.match(/https:\S+/)![0];
      expect(link).toMatch(
        /^https:\/\/charge\.example\.com\/invite#[A-Za-z0-9_-]{43}$/,
      );
      const token = tokenOf(link);
      const [invite] = store.state.invites;
      expect(invite.tokenHash).toBe(hashToken(token));
      expect(JSON.stringify(store.state)).not.toContain(token);
      expect(sent[0].key).toBe(`cpo-invite-${invite.id}`);
      expect(sent[0].email.subject).toContain("Sample Operator");
      expect(invite.expiresAt).toBe("2026-03-04T12:00:00.000Z");
    });

    it("hands the link back when no email provider is set", async () => {
      const { d } = setup("live", { mailer: null });
      const r = await inviteStaff(d, owner, {
        email: "a@example.com",
        role: "viewer",
      });
      expect(r.emailed).toBe(false);
      expect(r.link).toMatch(/\/invite#/);
    });

    it("revokes the invite when the email provider fails", async () => {
      const failing: Mailer = {
        send: vi.fn(async () => {
          throw new MailerError(500);
        }),
      };
      const { d } = setup("live", { mailer: failing });
      await expect(
        inviteStaff(d, owner, { email: "a@example.com", role: "viewer" }),
      ).rejects.toMatchObject({ code: "email_failed" });
      expect(await d.backend.pendingInvites(DEMO_OPERATOR_ID)).toEqual([]);
    });

    it("lets managers invite technicians and viewers only, and nobody below", async () => {
      const { d } = setup("live");
      for (const role of ["owner", "manager"])
        await expect(
          inviteStaff(d, manager, { email: "x@example.com", role }),
        ).rejects.toMatchObject({ code: "not_allowed" });
      await inviteStaff(d, manager, { email: "x@example.com", role: "viewer" });
      for (const actor of [technician, viewer])
        await expect(
          inviteStaff(d, actor, { email: "y@example.com", role: "viewer" }),
        ).rejects.toMatchObject({ code: "not_allowed" });
    });

    it("validates the email and role, and refuses existing staff", async () => {
      const { d } = setup("live");
      await expect(
        inviteStaff(d, owner, { email: "nope", role: "viewer" }),
      ).rejects.toMatchObject({ code: "invalid" });
      await expect(
        inviteStaff(d, owner, { email: "a@example.com", role: "admin" }),
      ).rejects.toMatchObject({ code: "invalid" });
      await expect(
        inviteStaff(d, owner, {
          email: "sample-viewer@example.com",
          role: "viewer",
        }),
      ).rejects.toMatchObject({ code: "already_staff" });
    });

    it("rate-limits invites per inviter and per recipient", async () => {
      const { d } = setup("live");
      // More invites than the sample store holds: count them only.
      let n = 0;
      d.backend.createInvite = async () =>
        `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      const send = (email: string) =>
        inviteStaff(d, owner, { email, role: "viewer" });
      for (let i = 0; i < LIMITS.inviteRecipient.quota; i++)
        await send("same@example.com");
      await expect(send("same@example.com")).rejects.toMatchObject({
        code: "rate_limited",
      });
      for (
        let i = LIMITS.inviteRecipient.quota + 1;
        i < LIMITS.inviteActor.quota;
        i++
      )
        await send(`p${i}@example.com`);
      await expect(send("last@example.com")).rejects.toMatchObject({
        code: "rate_limited",
      });
      clock = new Date(clock.getTime() + 3_600_000);
      await send("later@example.com");
    });

    it("revokes pending invites, within the actor's own roles", async () => {
      const { d } = setup("live");
      await inviteStaff(d, owner, { email: "m@example.com", role: "manager" });
      await inviteStaff(d, owner, { email: "v@example.com", role: "viewer" });
      const [m, v] = await d.backend.pendingInvites(DEMO_OPERATOR_ID);
      await expect(revokeStaffInvite(d, manager, m.id)).rejects.toMatchObject({
        code: "not_allowed",
      });
      await expect(revokeStaffInvite(d, viewer, v.id)).rejects.toMatchObject({
        code: "not_allowed",
      });
      await revokeStaffInvite(d, manager, v.id);
      expect(
        (await d.backend.pendingInvites(DEMO_OPERATOR_ID)).map((i) => i.id),
      ).toEqual([m.id]);
    });
  });

  describe("accepting an invite", () => {
    async function invited(mode: "demo" | "live") {
      const s = setup(mode, { mailer: null });
      const r = await inviteStaff(s.d, owner, {
        email: "joiner@example.com",
        role: "technician",
      });
      return { ...s, token: tokenOf(r.link!) };
    }

    it("creates the login, joins the team and signs in, once", async () => {
      const { d, accounts, token } = await invited("live");
      expect(await lookupInvite(d, token, "src")).toMatchObject({
        email: "joiner@example.com",
        role: "technician",
        operatorName: "Sample Operator",
      });
      await acceptStaffInvite(d, { token, password: PASSWORD }, "src");
      expect(accounts.createUser).toHaveBeenCalledWith(
        "joiner@example.com",
        PASSWORD,
      );
      expect(accounts.signInWithPassword).toHaveBeenCalledWith(
        "joiner@example.com",
        PASSWORD,
      );
      expect(await d.backend.staffForUser(NEW_USER)).toMatchObject({
        role: "technician",
      });
      await expect(
        acceptStaffInvite(d, { token, password: PASSWORD }, "src"),
      ).rejects.toMatchObject({ code: "invite_invalid" });
    });

    it("refuses expired, revoked, unknown and malformed tokens", async () => {
      const { d, token } = await invited("live");
      await expect(
        lookupInvite(d, "x".repeat(43), "src"),
      ).rejects.toMatchObject({ code: "invite_invalid" });
      await expect(lookupInvite(d, "short", "src")).rejects.toMatchObject({
        code: "invalid",
      });
      clock = new Date(clock.getTime() + 72 * 3_600_000 + 1);
      await expect(lookupInvite(d, token, "src")).rejects.toMatchObject({
        code: "invite_invalid",
      });
    });

    it("joins an existing login with its own password, never deleting it", async () => {
      const { d, store, accounts, token } = await invited("live");
      const EXISTING = "00000000-0000-4000-8000-0000000000bb";
      accounts.createUser.mockResolvedValue("exists");
      accounts.signInWithPassword.mockResolvedValueOnce(null);
      await expect(
        acceptStaffInvite(d, { token, password: "not its password" }, "src"),
      ).rejects.toMatchObject({ code: "account_exists" });

      accounts.signInWithPassword.mockResolvedValueOnce(EXISTING);
      d.backend.acceptInvite = vi.fn(async () => {
        throw new Error("database down");
      });
      await expect(
        acceptStaffInvite(d, { token, password: PASSWORD }, "src"),
      ).rejects.toThrow("database down");
      expect(accounts.deleteUser).not.toHaveBeenCalled();

      accounts.signInWithPassword.mockResolvedValueOnce(EXISTING);
      d.backend.acceptInvite = createDemoBackend(
        store,
        "Sample Operator",
        () => clock,
      ).acceptInvite;
      await acceptStaffInvite(d, { token, password: PASSWORD }, "src");
      expect(
        store.state.members.find((m) => m.email === "joiner@example.com"),
      ).toMatchObject({ userId: EXISTING, role: "technician" });
    });

    it("joins a signed-in invitee without a new login", async () => {
      const { d, accounts, token } = await invited("live");
      expect(await lookupInvite(d, token, "src")).toMatchObject({
        signedIn: false,
      });
      accounts.currentUser.mockResolvedValue({
        id: NEW_USER,
        email: "joiner@example.com",
      });
      // The page leaves out the password field.
      expect(await lookupInvite(d, token, "src")).toMatchObject({
        signedIn: true,
      });
      await acceptStaffInvite(d, { token, password: "" }, "src");
      expect(accounts.createUser).not.toHaveBeenCalled();
      expect(accounts.signInWithPassword).not.toHaveBeenCalled();
    });

    it("keeps an invitee's existing login signed in, so they can open the invite and join", async () => {
      const { d, accounts, token } = await invited("live");
      // Not on the team (for example removed earlier, with the login left behind).
      accounts.signInWithPassword.mockResolvedValueOnce(NEW_USER);
      await expect(
        signInWithPassword(
          d,
          { email: "joiner@example.com", password: PASSWORD },
          "src",
        ),
      ).rejects.toMatchObject({ code: "invite_pending" });
      expect(accounts.signOut).not.toHaveBeenCalled();
      // A sign-in link works for them too.
      await requestSignInLink(d, { email: "joiner@example.com" }, "src");
      expect(accounts.sendSignInLink).toHaveBeenCalledWith(
        "joiner@example.com",
      );
      accounts.currentUser.mockResolvedValue({
        id: NEW_USER,
        email: "joiner@example.com",
      });
      await acceptStaffInvite(d, { token, password: "" }, "src");
      expect(await d.backend.staffForUser(NEW_USER)).toMatchObject({
        role: "technician",
      });
    });

    it("deletes the new login when joining fails", async () => {
      const { d, accounts, token } = await invited("live");
      d.backend.acceptInvite = vi.fn(async () => {
        throw new Error("database down");
      });
      await expect(
        acceptStaffInvite(d, { token, password: PASSWORD }, "src"),
      ).rejects.toThrow("database down");
      expect(accounts.deleteUser).toHaveBeenCalledWith(NEW_USER);
    });

    it("needs a 12+ character password", async () => {
      const { d, token } = await invited("live");
      await expect(
        acceptStaffInvite(d, { token, password: "short" }, "src"),
      ).rejects.toMatchObject({ code: "invalid" });
    });

    it("works end to end in demo mode with no accounts", async () => {
      const { d, store, token } = await invited("demo");
      await acceptStaffInvite(d, { token, password: PASSWORD }, "src");
      expect(store.state.members.map((m) => m.email)).toContain(
        "joiner@example.com",
      );
      expect(store.state.invites).toEqual([]);
    });
  });

  describe("roles and removal", () => {
    it("never removes or demotes the last owner", async () => {
      const { d } = setup("live");
      await expect(
        changeStaffRole(d, owner, { userId: DEMO_OWNER_ID, role: "manager" }),
      ).rejects.toMatchObject({ code: "last_owner" });
      // A second owner makes stepping down possible.
      await changeStaffRole(d, owner, { userId: MANAGER_ID, role: "owner" });
      await changeStaffRole(d, owner, {
        userId: DEMO_OWNER_ID,
        role: "manager",
      });
      const second = { ...owner, userId: MANAGER_ID };
      await expect(removeStaff(d, second, MANAGER_ID)).rejects.toMatchObject({
        code: "not_allowed",
      });
      await expect(
        changeStaffRole(d, second, { userId: MANAGER_ID, role: "viewer" }),
      ).rejects.toMatchObject({ code: "last_owner" });
    });

    it("lets managers change and remove only technicians and viewers", async () => {
      const { d, accounts } = setup("live");
      await expect(
        changeStaffRole(d, manager, { userId: DEMO_OWNER_ID, role: "viewer" }),
      ).rejects.toMatchObject({ code: "not_allowed" });
      await expect(
        changeStaffRole(d, manager, { userId: TECH_ID, role: "manager" }),
      ).rejects.toMatchObject({ code: "not_allowed" });
      await changeStaffRole(d, manager, { userId: TECH_ID, role: "viewer" });
      await expect(
        removeStaff(d, manager, DEMO_OWNER_ID),
      ).rejects.toMatchObject({ code: "not_allowed" });
      await removeStaff(d, manager, VIEWER_ID);
      expect(accounts.deleteUser).toHaveBeenCalledWith(VIEWER_ID);
      expect(
        (await d.backend.members(DEMO_OPERATOR_ID)).map((m) => m.userId),
      ).not.toContain(VIEWER_ID);
    });

    it("refuses technicians and viewers, unknown people and bad input", async () => {
      const { d } = setup("live");
      for (const actor of [technician, viewer]) {
        await expect(
          changeStaffRole(d, actor, { userId: VIEWER_ID, role: "technician" }),
        ).rejects.toMatchObject({ code: "not_allowed" });
        await expect(removeStaff(d, actor, VIEWER_ID)).rejects.toMatchObject({
          code: "not_allowed",
        });
      }
      await expect(
        removeStaff(d, owner, "00000000-0000-4000-8000-000000000999"),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(removeStaff(d, owner, "not-a-uuid")).rejects.toMatchObject({
        code: "invalid",
      });
    });

    /**
     * Interleaves `between` after the service has read the team and before it writes:
     * the deterministic version of two staff members acting at the same moment.
     */
    function interleave(between: (b: TeamBackend) => Promise<void>) {
      const s = setup("live");
      const base = s.d.backend;
      let once = false;
      s.d.backend = {
        ...base,
        async members(operatorId) {
          const team = await base.members(operatorId);
          if (!once) {
            once = true;
            await between(base);
          }
          return team;
        },
      };
      return s;
    }
    const promoteTech = (b: TeamBackend) =>
      b.setRole(
        DEMO_OPERATOR_ID,
        {
          actor: { userId: DEMO_OWNER_ID, role: "owner" },
          target: { userId: TECH_ID, role: "technician" },
        },
        "owner",
      );

    it("refuses a manager's stale change after an owner promotes the target", async () => {
      const { d, store } = interleave(promoteTech);
      await expect(
        changeStaffRole(d, manager, { userId: TECH_ID, role: "viewer" }),
      ).rejects.toMatchObject({
        code: "changed",
        message: expect.stringMatching(/Reload the page/),
      });
      expect(store.state.members.find((m) => m.userId === TECH_ID)?.role).toBe(
        "owner",
      );
    });

    it("refuses a manager's stale removal after an owner promotes the target", async () => {
      const { d, store, accounts } = interleave(promoteTech);
      await expect(removeStaff(d, manager, TECH_ID)).rejects.toMatchObject({
        code: "changed",
      });
      expect(store.state.members.find((m) => m.userId === TECH_ID)?.role).toBe(
        "owner",
      );
      expect(accounts.deleteUser).not.toHaveBeenCalled();
    });

    it("refuses a change by someone demoted meanwhile", async () => {
      const { d } = interleave((b) =>
        b.setRole(
          DEMO_OPERATOR_ID,
          {
            actor: { userId: DEMO_OWNER_ID, role: "owner" },
            target: { userId: MANAGER_ID, role: "manager" },
          },
          "viewer",
        ),
      );
      await expect(
        changeStaffRole(d, manager, { userId: VIEWER_ID, role: "technician" }),
      ).rejects.toMatchObject({ code: "changed" });
    });

    it("revokes invites a demoted manager can no longer send", async () => {
      const { d } = setup("live", { mailer: null });
      await inviteStaff(d, manager, {
        email: "pending@example.com",
        role: "viewer",
      });
      expect(await d.backend.pendingInvites(DEMO_OPERATOR_ID)).toHaveLength(1);
      await changeStaffRole(d, owner, { userId: MANAGER_ID, role: "viewer" });
      expect(await d.backend.pendingInvites(DEMO_OPERATOR_ID)).toEqual([]);
    });
  });

  describe("setup", () => {
    function fresh() {
      const s = setup("live");
      s.store.state = { ...demoSeed(), members: [] };
      s.d.backend.hasStaff = async () => s.store.state.members.length > 0;
      s.d.backend.bootstrapOwner = vi.fn(async () => undefined);
      return s;
    }
    const form = {
      secret: SETUP_SECRET,
      operatorName: "Sample Operator",
      email: "first@example.com",
      password: PASSWORD,
    };

    it("creates the first owner with the setup secret and signs in", async () => {
      const { d, accounts } = fresh();
      await setupOwner(d, form, "src");
      expect(d.backend.bootstrapOwner).toHaveBeenCalledWith(
        NEW_USER,
        "first@example.com",
        "Sample Operator",
      );
      expect(accounts.signInWithPassword).toHaveBeenCalled();
    });

    it("refuses a wrong or missing secret, and a finished setup", async () => {
      const { d, accounts } = fresh();
      await expect(
        setupOwner(d, { ...form, secret: "wrong" }, "src"),
      ).rejects.toMatchObject({ code: "setup_secret" });
      await expect(
        setupOwner({ ...d, setupSecret: "too-short" }, form, "src"),
      ).rejects.toMatchObject({ code: "setup_disabled" });
      d.backend.hasStaff = async () => true;
      await expect(setupOwner(d, form, "src")).rejects.toMatchObject({
        code: "setup_done",
      });
      // Once set up, a wrong secret gets the same answer: nothing to probe.
      await expect(
        setupOwner(d, { ...form, secret: "wrong" }, "src"),
      ).rejects.toMatchObject({ code: "setup_done" });
      expect(accounts.createUser).not.toHaveBeenCalled();
    });

    it("deletes the login if the database refuses (someone else finished first)", async () => {
      const { d, accounts } = fresh();
      d.backend.bootstrapOwner = vi.fn(async () => {
        throw new Error("cpo_setup_done");
      });
      await expect(setupOwner(d, form, "src")).rejects.toThrow();
      expect(accounts.deleteUser).toHaveBeenCalledWith(NEW_USER);
    });

    it("is rate-limited per source", async () => {
      const { d } = fresh();
      for (let i = 0; i < LIMITS.setupSource.quota; i++)
        await setupOwner(d, { ...form, secret: "wrong" }, "src").catch(
          () => undefined,
        );
      await expect(setupOwner(d, form, "src")).rejects.toMatchObject({
        code: "rate_limited",
      });
    });
  });

  describe("sign-in", () => {
    it("signs staff in and signs out a login that is not on the team", async () => {
      const { d, accounts } = setup("live");
      accounts.signInWithPassword.mockResolvedValueOnce(TECH_ID);
      expect(
        await signInWithPassword(
          d,
          { email: "sample-technician@example.com", password: PASSWORD },
          "src",
        ),
      ).toMatchObject({ role: "technician" });
      await expect(
        signInWithPassword(
          d,
          { email: "gone@example.com", password: PASSWORD },
          "src",
        ),
      ).rejects.toMatchObject({ code: "no_access" });
      expect(accounts.signOut).toHaveBeenCalled();
      accounts.signInWithPassword.mockResolvedValueOnce(null);
      await expect(
        signInWithPassword(
          d,
          { email: "x@example.com", password: "wrong" },
          "src",
        ),
      ).rejects.toMatchObject({ code: "sign_in_failed" });
    });

    it("rate-limits password attempts per account", async () => {
      const { d, accounts } = setup("live");
      accounts.signInWithPassword.mockResolvedValue(null);
      const attempt = (source: string) =>
        signInWithPassword(
          d,
          { email: "target@example.com", password: "guess" },
          source,
        );
      for (let i = 0; i < LIMITS.passwordAccount.quota; i++)
        await expect(attempt(`src-${i}`)).rejects.toMatchObject({
          code: "sign_in_failed",
        });
      await expect(attempt("another-source")).rejects.toMatchObject({
        code: "rate_limited",
      });
    });

    it("emails links to staff only, answering the same for anyone", async () => {
      const { d, accounts } = setup("live");
      await requestSignInLink(d, { email: "sample-viewer@example.com" }, "s");
      await requestSignInLink(d, { email: "stranger@example.com" }, "s");
      expect(accounts.sendSignInLink).toHaveBeenCalledTimes(1);
      expect(accounts.sendSignInLink).toHaveBeenCalledWith(
        "sample-viewer@example.com",
      );
      await expect(
        requestSignInLink(d, { email: "sample-viewer@example.com" }, "s"),
      ).rejects.toMatchObject({ code: "rate_limited" });
    });

    it("has nothing to sign in to in demo mode", async () => {
      const { d } = setup("demo");
      await expect(
        signInWithPassword(d, { email: "a@example.com", password: "x" }, "s"),
      ).rejects.toMatchObject({ code: "demo_only" });
    });
  });

  it("never logs email addresses, passwords or tokens", async () => {
    const { d } = setup("live");
    const r = await inviteStaff(d, owner, {
      email: "private.person@example.com",
      role: "viewer",
    });
    const failing = setup("live", {
      mailer: {
        send: async () => {
          throw new MailerError(422);
        },
      },
    });
    await inviteStaff(failing.d, owner, {
      email: "private.person@example.com",
      role: "viewer",
    }).catch(() => undefined);
    const { d: d2 } = setup("live", { mailer: null });
    const link = (
      await inviteStaff(d2, owner, {
        email: "private.person@example.com",
        role: "viewer",
      })
    ).link!;
    await acceptStaffInvite(
      d2,
      { token: tokenOf(link), password: PASSWORD },
      "src",
    );
    expect(r.emailed).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
    const all = logs.join("\n");
    expect(all).not.toContain("private.person");
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(tokenOf(link));
  });
});
