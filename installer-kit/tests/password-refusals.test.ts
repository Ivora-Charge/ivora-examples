import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "@/lib/server/backend";
import { demoBackend } from "@/lib/server/demo-backend";
import { IvoraError } from "@/lib/server/errors";
import { publicError } from "@/lib/server/http";
import { IvoraClient, liveBackend } from "@/lib/server/ivora";
import {
  addCharger,
  createSite,
  rotatePassword,
  setBackendForTests,
} from "@/lib/server/service";
import { resetStoreForTests } from "@/lib/server/store";
import {
  LIVE_PUSH_PATTERN,
  PASSWORD_PATTERN,
  generatePassword,
} from "@/lib/credentials";
import { nextStep } from "@/lib/next-step";

type Reply = { status: number; body: unknown };

const apiError = (code: string) => ({
  error: { code, message: `${code} message` },
  request_id: "req_1",
});
const succeeded = {
  id: "op_1",
  tenant_id: 42,
  status: "succeeded",
  result: { applied: "stored" },
  created_at: "",
  updated_at: "",
};

/** The live Ivora client over a fake fetch that answers queued replies. */
function fakeLive(replies: Reply[]) {
  const bodies: unknown[] = [];
  const fetch = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
    bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
    const r = replies.shift();
    if (!r) throw new Error("Unexpected request");
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  });
  const client = new IvoraClient({
    apiKey: "test-key",
    tenantId: "42",
    origin: "https://api.ivoracharge.com",
    fetch: fetch as unknown as typeof globalThis.fetch,
    sleep: async () => {},
  });
  return { fetch, bodies, live: liveBackend(client) };
}

const REFUSALS: [string, number][] = [
  ["password_not_hex", 409],
  ["password_push_unproven_vendor", 409],
  ["stations_admin_required", 403],
];

describe("generated station passwords", () => {
  it("are 40 hex characters, valid both stored and pushed live", () => {
    const all = new Set(Array.from({ length: 200 }, generatePassword));
    expect(all.size).toBe(200);
    for (const pw of all) {
      expect(pw).toMatch(/^[0-9a-f]{40}$/);
      expect(pw).toMatch(PASSWORD_PATTERN);
      expect(pw).toMatch(LIVE_PUSH_PATTERN);
    }
  });

  it("describe the live-push rule: even-length hex, 32 to 40", () => {
    expect("a".repeat(32)).toMatch(LIVE_PUSH_PATTERN);
    expect("a".repeat(40)).toMatch(LIVE_PUSH_PATTERN);
    expect("a".repeat(30)).not.toMatch(LIVE_PUSH_PATTERN);
    expect("a".repeat(33)).not.toMatch(LIVE_PUSH_PATTERN);
    expect("a".repeat(42)).not.toMatch(LIVE_PUSH_PATTERN);
    expect("g".repeat(32)).not.toMatch(LIVE_PUSH_PATTERN);
  });
});

describe("refused password changes on a connected charger", () => {
  beforeEach(() => resetStoreForTests());
  afterEach(() => setBackendForTests(null));

  it.each(REFUSALS)(
    "%s is not retried, keeps the old password and reaches the operator",
    async (code, status) => {
      // Create stores the password (the station is offline); the later
      // rotation of the connected charger is refused.
      const { fetch, bodies, live } = fakeLive([
        { status: 200, body: succeeded },
        { status, body: apiError(code) },
      ]);
      const backend: Backend = {
        ...demoBackend,
        demo: false,
        async createLocation() {
          return "loc";
        },
        async createStation() {
          return {
            stationId: "7",
            connectionUrl: "wss://x.invalid",
            username: "u",
          };
        },
        setPassword: (s, p, k) => live.setPassword(s, p, k),
      };
      setBackendForTests(backend);
      const site = await createSite({ name: "Site", address: "1 Main St" });
      const created = await addCharger({ siteId: site.id, name: "ik-hex-1" });
      expect(created.password).toMatch(LIVE_PUSH_PATTERN);
      expect(created.charger.passwordSet).toBe(true);

      const err = await rotatePassword(created.charger.id).catch((e) => e);
      expect(err).toBeInstanceOf(IvoraError);
      expect(err).toMatchObject({ status, code });
      // One request for the create, one for the rotation: no retry.
      expect(fetch).toHaveBeenCalledTimes(2);
      expect((bodies[1] as { password: string }).password).toMatch(
        /^[0-9a-f]{40}$/,
      );
      // Ivora refused outright, so the charger still has its old password.
      expect(created.charger.passwordSet).toBe(true);
      const body = publicError(err).body;
      expect(body.error).toBe(code);
      expect(JSON.stringify(body)).not.toContain(created.password!);
    },
  );

  it("an unconfirmed change still marks the password as not set", async () => {
    const { live } = fakeLive([
      { status: 200, body: succeeded },
      { status: 502, body: apiError("password_unconfirmed") },
    ]);
    setBackendForTests({
      ...demoBackend,
      demo: false,
      async createLocation() {
        return "loc";
      },
      async createStation() {
        return {
          stationId: "7",
          connectionUrl: "wss://x.invalid",
          username: "u",
        };
      },
      setPassword: (s, p, k) => live.setPassword(s, p, k),
    });
    const site = await createSite({ name: "Site", address: "1 Main St" });
    const created = await addCharger({ siteId: site.id, name: "ik-hex-2" });
    await expect(rotatePassword(created.charger.id)).rejects.toMatchObject({
      code: "password_unconfirmed",
    });
    expect(created.charger.passwordSet).toBe(false);
  });
});

describe("next steps for password errors", () => {
  const generic = "Check the value you entered, then try again.";

  it("password_not_hex points at setting a new (hex) password", () => {
    const s = nextStep({ error: "password_not_hex" });
    expect(s).not.toBe(generic);
    expect(s).toMatch(/32 to 40 hexadecimal/);
    expect(s).toMatch(/Set a new password/);
  });

  it("password_push_unproven_vendor says to set it on the charger by hand", () => {
    expect(nextStep({ error: "password_push_unproven_vendor" })).toBe(
      "This charger model isn't approved for remote password changes yet: set the password on the charger itself, then save it here while the charger is offline.",
    );
  });

  it("stations_admin_required names the missing scope, not a sign-in", () => {
    const s = nextStep({ error: "stations_admin_required" });
    expect(s).toMatch(/stations:admin/);
    expect(s).not.toMatch(/Sign in again/);
  });

  it("keeps the generic rules for other errors", () => {
    expect(nextStep({ error: "network_error" })).toMatch(/connection/);
    expect(nextStep({ error: "http_401" })).toMatch(/Sign in again/);
    expect(nextStep({ error: "http_503" })).toMatch(/site operator/);
    expect(nextStep({ error: "invalid_input" })).toBe(generic);
  });
});
