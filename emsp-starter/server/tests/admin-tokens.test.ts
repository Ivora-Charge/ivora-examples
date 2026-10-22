import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addRfidCardAction,
  changeTokenAction,
  createAppTokenAction,
  driverTokensAction,
  retryPushesAction,
} from "@/app/admin/tokens/actions";
import { setPeerStoreForTests } from "@/lib/ocpi/registry";
import { MemoryPeerStore } from "@/lib/ocpi/store";
import { resetAdminLimitForTests } from "@/lib/server/admin";
import { DEMO_DRIVER_REF, setTokenStoreForTests } from "@/lib/tokens/registry";
import { MemoryTokenStore } from "@/lib/tokens/store";
import { LIVE_ENV } from "./support/network";

const SECRET = "s".repeat(32);
const saved = { ...process.env };
let fetchSpy: ReturnType<typeof vi.fn>;

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

beforeEach(() => {
  resetAdminLimitForTests();
  for (const k of Object.keys(LIVE_ENV)) delete process.env[k];
  process.env.DEMO_MODE = "true";
  process.env.ADMIN_SECRET = SECRET;
  setPeerStoreForTests(new MemoryPeerStore());
  fetchSpy = vi.fn(() => {
    throw new Error("no network in tests");
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  setPeerStoreForTests(undefined);
  setTokenStoreForTests(undefined);
  vi.unstubAllGlobals();
  process.env = { ...saved };
});

describe("admin token actions (demo mode)", () => {
  it("needs the admin secret", async () => {
    expect(
      await driverTokensAction(
        {},
        form({ driverRef: DEMO_DRIVER_REF, adminSecret: "wrong" }),
      ),
    ).toMatchObject({ ok: false, message: "Wrong admin secret." });
  });

  it("looks up the demo driver, issues, blocks and adds a card, pushing nothing", async () => {
    setTokenStoreForTests(new MemoryTokenStore());
    const created = await createAppTokenAction(
      {},
      form({ driverRef: "driver-9", whitelist: "NEVER", adminSecret: SECRET }),
    );
    expect(created).toMatchObject({
      ok: true,
      message: "App token created. Demo mode: not pushed to any CPO.",
      tokens: [
        {
          type: "APP_USER",
          driverRef: "driver-9",
          whitelist: "NEVER",
          valid: true,
        },
      ],
    });
    const uid = created.tokens![0].uid;
    expect(
      await changeTokenAction(
        {},
        form({ uid, type: "APP_USER", intent: "block", adminSecret: SECRET }),
      ),
    ).toMatchObject({
      ok: true,
      tokens: [{ status: "blocked", valid: false }],
    });
    expect(
      await changeTokenAction(
        {},
        form({ uid, type: "CARD", intent: "block", adminSecret: SECRET }),
      ),
    ).toMatchObject({ ok: false, message: "Type must be APP_USER or RFID." });
    expect(
      await addRfidCardAction(
        {},
        form({ driverRef: "nobody", uid: "0A0B0C0D", adminSecret: SECRET }),
      ),
    ).toMatchObject({
      ok: false,
      message:
        "This driver has no app token yet: create one first, then add the card.",
    });
    expect(
      (
        await driverTokensAction(
          {},
          form({ driverRef: "driver-9", adminSecret: SECRET }),
        )
      ).tokens,
    ).toHaveLength(1);
    expect(await retryPushesAction({}, form({ adminSecret: SECRET }))).toEqual({
      ok: true,
      message: "Demo mode: nothing is pushed to a CPO.",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows the sample driver's tokens in demo mode", async () => {
    const res = await driverTokensAction(
      {},
      form({ driverRef: DEMO_DRIVER_REF, adminSecret: SECRET }),
    );
    expect(res.tokens?.map((t) => t.type)).toEqual(["APP_USER", "RFID"]);
  });
});
