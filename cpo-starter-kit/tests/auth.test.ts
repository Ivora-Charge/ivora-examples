import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Next.js request APIs, replaced for plain Node: a cookie jar and a redirect that throws.
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
  unstable_rethrow: () => undefined,
}));

import { ROLES } from "@/lib/roles";
import {
  AccessDeniedError,
  checkRole,
  currentStaff,
  requireRole,
} from "@/lib/server/auth";
import { serviceClient, sessionClient } from "@/lib/server/supabase";
import {
  changeStaffRole,
  getTeam,
  inviteStaff,
  removeStaff,
  acceptStaffInvite,
  revokeStaffInvite,
} from "@/lib/server/team";
import { DEMO_OWNER_ID } from "@/lib/server/team/demo";
import type { Staff } from "@/lib/server/team/types";

const VARS = [
  "IVORA_API_KEY",
  "IVORA_TENANT_ID",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "DEMO_MODE",
];

describe("requireRole and demo sign-in", () => {
  const saved = { ...process.env };
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    for (const k of VARS) delete process.env[k];
    jar.clear();
    fetchSpy = vi.fn(() => {
      throw new Error("demo mode must not call fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  it("checks the role matrix for every signed-in role", () => {
    for (const role of ROLES) {
      const staff = { role } as Staff;
      for (const min of ROLES) {
        const ok = ROLES.indexOf(role) <= ROLES.indexOf(min);
        if (ok) expect(checkRole(staff, min)).toBe(staff);
        else expect(() => checkRole(staff, min)).toThrow(AccessDeniedError);
      }
    }
    expect(checkRole(null, "viewer")).toBeNull();
  });

  it("signs demo mode in as the labelled demo owner", async () => {
    const me = await currentStaff();
    expect(me).toMatchObject({
      userId: DEMO_OWNER_ID,
      role: "owner",
      demo: true,
      email: "demo-owner@example.com",
    });
    expect(await requireRole("owner")).toMatchObject({ role: "owner" });
  });

  it("follows the demo owner's role and redirects when they are gone", async () => {
    const team = getTeam();
    const owner = (await currentStaff())!;
    // Hand ownership to the sample manager, then step down.
    const [, mgr] = await team.backend.members(owner.operatorId);
    await changeStaffRole(team, owner, { userId: mgr.userId, role: "owner" });
    await changeStaffRole(team, owner, {
      userId: owner.userId,
      role: "viewer",
    });
    await expect(requireRole("manager")).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    expect(await requireRole("viewer")).toMatchObject({ role: "viewer" });
    // Remove the demo owner (as the new owner): not signed in any more.
    await removeStaff(team, { ...owner, ...mgr, role: "owner" }, owner.userId);
    await expect(requireRole("viewer")).rejects.toThrow("NEXT_REDIRECT /login");
  });

  it("runs every team flow in demo mode without any network call", async () => {
    const team = getTeam();
    expect(team.backend.mode).toBe("demo");
    expect(team.mailer).toBeNull();
    expect(team.accounts).toBeNull();
    const owner = (await requireRole("manager"))!;

    const r = await inviteStaff(team, owner, {
      email: "new@example.com",
      role: "technician",
    });
    expect(r.preview?.text).toContain("/invite#");
    expect(r.emailed).toBe(false);
    await acceptStaffInvite(
      team,
      {
        token: new URL(r.link!).hash.slice(1),
        password: "long enough password",
      },
      "local",
    );
    const joined = (await team.backend.members(owner.operatorId)).find(
      (m) => m.email === "new@example.com",
    )!;
    await changeStaffRole(team, owner, {
      userId: joined.userId,
      role: "viewer",
    });
    await removeStaff(team, owner, joined.userId);
    const second = await inviteStaff(team, owner, {
      email: "other@example.com",
      role: "viewer",
    });
    const [pending] = await team.backend.pendingInvites(owner.operatorId);
    expect(second.email).toBe(pending.email);
    await revokeStaffInvite(team, owner, pending.id);

    // The demo team lives in the visitor's cookie only.
    expect(jar.has("cpo_demo_team")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps Supabase clients off in demo mode, even with keys set", async () => {
    process.env.SUPABASE_URL = "https://supabase.example.test";
    process.env.SUPABASE_ANON_KEY = "test-anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    expect(() => serviceClient()).toThrow(/Demo mode/);
    await expect(sessionClient()).rejects.toThrow(/Demo mode/);
    expect(getTeam().backend.mode).toBe("demo");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reads the role from the database in live mode, never from user metadata", async () => {
    process.env.IVORA_API_KEY = "test-key";
    process.env.IVORA_TENANT_ID = "42";
    process.env.SUPABASE_URL = "https://supabase.example.test";
    process.env.SUPABASE_ANON_KEY = "test-anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    const userId = "10000000-0000-4000-8000-000000000001";
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(
          String(input instanceof Request ? input.url : input),
        );
        seen.push(url.pathname);
        if (url.pathname === "/auth/v1/user")
          // Metadata claims "owner": it must be ignored.
          return Response.json({
            id: userId,
            email: "tech@example.com",
            aud: "authenticated",
            user_metadata: { role: "owner" },
            app_metadata: { role: "owner" },
          });
        if (url.pathname === "/rest/v1/cpo_staff")
          return Response.json({
            operator_id: "op-1",
            user_id: userId,
            email: "tech@example.com",
            role: "technician",
          });
        if (url.pathname === "/rest/v1/cpo_operators")
          return Response.json({ name: "Sample Operator" });
        return new Response("unexpected", { status: 500 });
      }),
    );
    // A session cookie as @supabase/ssr stores it (base64 JSON).
    const session = {
      access_token: "header.payload.signature",
      refresh_token: "refresh-token-not-real",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: userId },
    };
    jar.set(
      "sb-supabase-auth-token",
      `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`,
    );
    const me = await requireRole("viewer");
    expect(me).toMatchObject({ role: "technician", demo: false });
    await expect(requireRole("manager")).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    expect(seen).toContain("/auth/v1/user");
    expect(seen).toContain("/rest/v1/cpo_staff");
  });
});
