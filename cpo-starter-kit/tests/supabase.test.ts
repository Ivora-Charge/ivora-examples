import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], set: () => undefined }),
  headers: async () => new Headers(),
}));

import { createSupabaseLiveStore } from "@/lib/server/live/supabase";
import { inviteEmail, MailerError, ResendMailer } from "@/lib/server/mail";
import {
  createSupabaseBackend,
  createSupabaseLimiter,
} from "@/lib/server/team/supabase";

// Supabase is replaced at the HTTP boundary: a fake fetch answers like PostgREST.

const SERVICE_KEY = "test-service-role-key";
type Call = { url: URL; method: string; body: unknown; apikey: string | null };

function fakeSupabase(answer: (c: Call) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      const text = await req.text();
      const call = {
        url: new URL(req.url),
        method: req.method,
        body: text ? JSON.parse(text) : undefined,
        apikey: req.headers.get("apikey"),
      };
      calls.push(call);
      return answer(call);
    }),
  );
  return calls;
}

const CHECKED = {
  actor: { userId: "user-0", role: "manager" as const },
  target: { userId: "user-1", role: "technician" as const },
};

const pgError = (message: string, status = 400) =>
  Response.json(
    { code: "P0001", message, details: null, hint: null },
    { status },
  );

describe("Supabase team backend", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, {
      IVORA_API_KEY: "test-key",
      IVORA_TENANT_ID: "42",
      SUPABASE_URL: "https://supabase.example.test",
      SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    });
    delete process.env.DEMO_MODE;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  it("creates invites through the RPC with the service role key", async () => {
    const calls = fakeSupabase(() => Response.json("invite-id"));
    const id = await createSupabaseBackend().createInvite({
      operatorId: "op-1",
      email: "a@example.com",
      role: "viewer",
      tokenHash: "f".repeat(64),
      invitedBy: "user-1",
      expiresAt: new Date("2026-03-04T12:00:00Z"),
    });
    expect(id).toBe("invite-id");
    expect(calls[0].url.pathname).toBe("/rest/v1/rpc/cpo_create_invite");
    expect(calls[0].apikey).toBe(SERVICE_KEY);
    expect(calls[0].body).toEqual({
      p_operator_id: "op-1",
      p_email: "a@example.com",
      p_role: "viewer",
      p_token_hash: "f".repeat(64),
      p_invited_by: "user-1",
      p_expires_at: "2026-03-04T12:00:00.000Z",
    });
  });

  it("changes roles and removes staff through RPCs that re-check both roles", async () => {
    const calls = fakeSupabase(() => new Response(null, { status: 204 }));
    const b = createSupabaseBackend();
    await b.setRole("op-1", CHECKED, "viewer");
    await b.removeMember("op-1", CHECKED);
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/rest/v1/rpc/cpo_set_staff_role",
      "/rest/v1/rpc/cpo_remove_staff",
    ]);
    const expected = {
      p_operator_id: "op-1",
      p_actor_id: "user-0",
      p_actor_role: "manager",
      p_user_id: "user-1",
      p_expected_role: "technician",
    };
    expect(calls[0].body).toEqual({ ...expected, p_role: "viewer" });
    expect(calls[1].body).toEqual(expected);
    expect(calls.every((c) => c.apikey === SERVICE_KEY)).toBe(true);
  });

  it.each([
    ["cpo_last_owner", "last_owner"],
    ["cpo_changed_meanwhile", "changed"],
    ["cpo_already_staff", "already_staff"],
    ["cpo_invite_invalid", "invite_invalid"],
    ["cpo_setup_done", "setup_done"],
  ])("maps the database's %s to %s", async (raised, code) => {
    fakeSupabase(() => pgError(raised));
    await expect(
      createSupabaseBackend().setRole("op-1", CHECKED, "viewer"),
    ).rejects.toMatchObject({ code });
  });

  it("hides other database messages, keeping only the code", async () => {
    fakeSupabase(() =>
      Response.json(
        { code: "42501", message: "permission denied for secret@example.com" },
        { status: 401 },
      ),
    );
    const e = await createSupabaseBackend()
      .removeMember("op-1", CHECKED)
      .catch((x: Error) => x);
    expect(String(e)).toContain("42501");
    expect(String(e)).not.toContain("secret@example.com");
  });

  it("takes rate limits through the shared RPC", async () => {
    const calls = fakeSupabase(() => Response.json(false));
    expect(await createSupabaseLimiter().take("k", 1, 60)).toBe(false);
    expect(calls[0].body).toEqual({
      bucket_key: "k",
      quota: 1,
      period_seconds: 60,
    });
  });
});

describe("Resend mailer", () => {
  it("sends with the idempotency key and reports refusals by status only", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = new ResendMailer(
      "test-resend-key",
      "Team <team@example.com>",
      (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Response.json({ id: "email-1" });
      }) as unknown as typeof fetch,
    );
    const email = inviteEmail({
      to: "a@example.com",
      operatorName: "Sample <Operator>",
      roleLabel: "Viewer",
      link: "https://charge.example.com/invite#abc",
      expiresHours: 72,
    });
    await ok.send(email, "cpo-invite-1");
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("idempotency-key")).toBe("cpo-invite-1");
    expect(headers.get("authorization")).toBe("Bearer test-resend-key");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      to: ["a@example.com"],
      subject: "You're invited to join Sample <Operator>",
    });
    // The operator name is escaped in HTML.
    expect(email.html).toContain("Sample &lt;Operator&gt;");

    const refused = new ResendMailer(
      "k",
      "f",
      (async () =>
        new Response("no", { status: 403 })) as unknown as typeof fetch,
    );
    await expect(refused.send(email, "k-1")).rejects.toEqual(
      new MailerError(403),
    );
  });
});

describe("Supabase session tracker", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, {
      IVORA_API_KEY: "test-key",
      IVORA_TENANT_ID: "42",
      SUPABASE_URL: "https://supabase.example.test",
      SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    });
    delete process.env.DEMO_MODE;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  const sessionRow = (id: number, station: number, active: boolean) => ({
    transaction_id: id,
    station_id: station,
    connector_id: 7,
    connector_number: 1,
    id_token: "****ABCD",
    started_at: "2026-10-22T08:00:00Z",
    ended_at: active ? null : "2026-10-22T09:00:00Z",
    energy_wh: "1200",
    active,
    checked_at: "2026-10-22T09:59:00Z",
    changed_at: "2026-10-22T09:59:00Z",
  });

  /** Answers like PostgREST for the filters the store uses. */
  function table(rows: ReturnType<typeof sessionRow>[]) {
    return fakeSupabase(({ url }) => {
      const p = url.searchParams;
      const eq = (k: string) => p.get(k)?.replace(/^eq\./, "");
      const lt = Number(p.get("transaction_id")?.replace(/^lt\./, "") ?? NaN);
      const out = rows
        .filter(
          (r) =>
            (!p.has("active") || String(r.active) === eq("active")) &&
            (!p.has("station_id") ||
              String(r.station_id) === eq("station_id")) &&
            (Number.isNaN(lt) || r.transaction_id < lt),
        )
        .sort((a, b) => b.transaction_id - a.transaction_id)
        .slice(0, Number(p.get("limit") ?? 1000));
      return Response.json(out);
    });
  }

  it("reads every running session in keyset pages, past any cap, and only them", async () => {
    const rows = [
      ...Array.from({ length: 2_300 }, (_, i) => sessionRow(i + 1, 5, true)),
      ...Array.from({ length: 600 }, (_, i) => sessionRow(5_000 + i, 5, false)),
    ];
    const calls = table(rows);
    const list = await createSupabaseLiveStore().listActiveSessions();
    expect(list.length).toBe(2_300);
    expect(list[list.length - 1].transactionId).toBe(1);
    expect(calls.length).toBe(3);
    expect(
      calls.every((c) => c.url.searchParams.get("active") === "eq.true"),
    ).toBe(true);
    expect(calls[1].url.searchParams.get("transaction_id")).toBe("lt.1301");
  });

  it("filters by station in the query, and pages ended sessions", async () => {
    const calls = table([
      sessionRow(1, 5, true),
      sessionRow(2, 6, true),
      ...Array.from({ length: 30 }, (_, i) => sessionRow(100 + i, 5, false)),
    ]);
    const store = createSupabaseLiveStore();
    expect(
      (await store.listActiveSessions({ stationId: 5 })).map(
        (t) => t.transactionId,
      ),
    ).toEqual([1]);
    expect(calls[0].url.searchParams.get("station_id")).toBe("eq.5");
    const page = await store.listEndedSessions(5, { before: 120, limit: 5 });
    expect(page.map((t) => t.transactionId)).toEqual([119, 118, 117, 116, 115]);
  });

  it("skips a row it can't read, with a log, instead of failing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    table([
      sessionRow(1, 5, true),
      { ...sessionRow(2, 5, true), checked_at: "garbage" },
      { ...sessionRow(3, 5, true), energy_wh: "-4" },
    ]);
    const list = await createSupabaseLiveStore().listActiveSessions();
    expect(list.map((t) => [t.transactionId, t.energyWh])).toEqual([
      [3, null],
      [1, 1200],
    ]);
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});
