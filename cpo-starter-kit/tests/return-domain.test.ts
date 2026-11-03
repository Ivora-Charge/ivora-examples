import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RETURN_URL_MAX,
  returnTxtRecord,
  sessionReturnUrl,
} from "@/lib/server/checkout/return-url";
import { IvoraError } from "@/lib/server/ivora/errors";
import { createLiveClient } from "@/lib/server/ivora/live";
import type { IvoraClient, ReturnDomain } from "@/lib/server/ivora/types";
import {
  loadReturnDomain,
  registerReturnDomain,
  verifyReturnDomain,
} from "@/lib/server/onboarding/return-domain";
import type { Staff } from "@/lib/server/team/types";

const ID = "30000000-0000-4000-8000-000000000001";
const base = {
  ok: true as const,
  base: "https://charge.example.com",
  demo: false,
};
const manager = { role: "manager" } as Staff;
const viewer = { role: "viewer" } as Staff;

describe("the session return URL", () => {
  it("is <origin>/s/<id> for an https hostname", () => {
    expect(sessionReturnUrl("https://charge.example.com", ID)).toBe(
      `https://charge.example.com/s/${ID}`,
    );
  });

  it("refuses http, credentials, fragments, IP addresses, bare hosts and anything over 512 characters", () => {
    for (const origin of [
      "http://charge.example.com",
      "https://user:pw@charge.example.com",
      "https://charge.example.com/#x",
      "https://203.0.113.7",
      "https://[2001:db8::1]",
      "https://2130706433",
      "https://localhost",
      "not a url",
      "",
      null,
    ])
      expect(sessionReturnUrl(origin, ID), String(origin)).toBeNull();
    const long = `https://${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(60)}.example.com`;
    expect(sessionReturnUrl(long, "x".repeat(RETURN_URL_MAX))).toBeNull();
  });

  it("names the TXT record as Ivora's docs do", () => {
    expect(returnTxtRecord("charge.example.com", "tok")).toEqual({
      name: "_ivora-return.charge.example.com",
      value: "ivora-return-verification=tok",
    });
  });
});

function fake(domains: ReturnDomain[]) {
  const api = {
    listReturnDomains: vi.fn(async () => structuredClone(domains)),
    createReturnDomain: vi.fn(
      async (hostname: string): Promise<ReturnDomain> => ({
        id: 7,
        hostname,
        ready: false,
        verification_token: "tok123",
      }),
    ),
    verifyReturnDomain: vi.fn(
      async (id: string | number): Promise<ReturnDomain> => ({
        id,
        hostname: "charge.example.com",
        ready: true,
      }),
    ),
  };
  return { api, d: { ivora: api as unknown as IvoraClient } };
}

describe("onboarding: return domain", () => {
  beforeEachSilence();

  it("registers the hostname once, shows the TXT record, and verifies until ready", async () => {
    const { api, d } = fake([]);
    expect((await loadReturnDomain(d, base, false)).ok).toBe(true);
    expect(await loadReturnDomain(d, base, false)).toMatchObject({
      view: { state: "not_registered", hostname: "charge.example.com" },
    });
    const reg = await registerReturnDomain(d, manager, base);
    expect(reg).toMatchObject({
      ok: true,
      view: {
        state: "pending",
        txt: {
          name: "_ivora-return.charge.example.com",
          value: "ivora-return-verification=tok123",
        },
      },
    });
    expect(api.createReturnDomain).toHaveBeenCalledWith(
      "charge.example.com",
      "cpo-return-domain-charge.example.com-create",
    );

    const pending = fake([
      { id: 7, hostname: "Charge.Example.com", ready: false },
    ]);
    const ready = await verifyReturnDomain(pending.d, manager, base, () => 5);
    expect(ready).toMatchObject({ ok: true, view: { state: "ready" } });
    expect(pending.api.verifyReturnDomain).toHaveBeenCalledWith(
      7,
      "cpo-return-domain-7-5-verify",
    );
  });

  it("keeps a failed verification pending, and needs a manager", async () => {
    const { api, d } = fake([
      { id: 7, hostname: "charge.example.com", ready: false },
    ]);
    api.verifyReturnDomain.mockResolvedValue({
      id: 7,
      hostname: "charge.example.com",
      ready: false,
    });
    expect(await verifyReturnDomain(d, manager, base)).toMatchObject({
      ok: true,
      view: { state: "pending" },
    });
    await expect(registerReturnDomain(d, viewer, base)).rejects.toMatchObject({
      code: "not_allowed",
    });
    await expect(verifyReturnDomain(d, viewer, base)).rejects.toMatchObject({
      code: "not_allowed",
    });
  });

  it("asks for the key's domain scopes on a 403, and has no origin without a stable domain", async () => {
    const { api, d } = fake([]);
    api.listReturnDomains.mockRejectedValue(
      new IvoraError(403, "forbidden", "Missing scope", "req_1"),
    );
    expect(await loadReturnDomain(d, base, false)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/scopes/),
    });
    const none = { ok: false as const, reason: "Set PUBLIC_BASE_URL." };
    expect(await loadReturnDomain(fake([]).d, none, false)).toMatchObject({
      view: { state: "no_origin" },
    });
    expect(await registerReturnDomain(fake([]).d, manager, none)).toMatchObject(
      {
        ok: false,
      },
    );
  });

  it("shows a sample in demo mode and calls nothing", async () => {
    const { api, d } = fake([]);
    expect(await loadReturnDomain(d, base, true)).toMatchObject({
      view: { state: "demo" },
    });
    expect(api.listReturnDomains).not.toHaveBeenCalled();
  });
});

describe("live client return domains", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.IVORA_API_KEY = "test-key-not-real";
    process.env.IVORA_TENANT_ID = "12";
    process.env.SUPABASE_URL = "https://supabase.example.test";
    process.env.SUPABASE_ANON_KEY = "test-anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    delete process.env.DEMO_MODE;
  });
  afterEach(() => {
    process.env = { ...saved };
  });
  it("lists, registers and verifies under the tenant, with Idempotency-Keys on the writes", async () => {
    const calls: {
      url: string;
      method: string;
      key: string | null;
      body: unknown;
    }[] = [];
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(url),
          method: init?.method ?? "GET",
          key: new Headers(init?.headers).get("idempotency-key"),
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(
          JSON.stringify(
            init?.method === "POST"
              ? { id: 7, hostname: "charge.example.com", ready: true }
              : {
                  data: [
                    { id: 7, hostname: "charge.example.com", ready: true },
                  ],
                },
          ),
          { status: 200 },
        );
      },
    );
    const c = createLiveClient({
      baseUrl: "https://api.example.test",
      apiKey: "k",
      tenantId: "12",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await c.listReturnDomains();
    await c.createReturnDomain(
      "charge.example.com",
      "cpo-return-domain-x-create",
    );
    await c.verifyReturnDomain(7, "cpo-return-domain-7-1-verify");
    expect(calls.map((x) => [x.method, x.url, x.key])).toEqual([
      ["GET", "https://api.example.test/v1/tenants/12/return-domains", null],
      [
        "POST",
        "https://api.example.test/v1/tenants/12/return-domains",
        "cpo-return-domain-x-create",
      ],
      [
        "POST",
        "https://api.example.test/v1/tenants/12/return-domains/7/verify",
        "cpo-return-domain-7-1-verify",
      ],
    ]);
    expect(calls[1].body).toEqual({ hostname: "charge.example.com" });
  });
});

function beforeEachSilence() {
  vi.spyOn(console, "error").mockImplementation(() => {});
}
