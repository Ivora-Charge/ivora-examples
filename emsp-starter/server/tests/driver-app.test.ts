import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Admin actions read the request's cookies and headers; tests set none.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

import { clearUserCacheForTests } from "@/lib/accounts/api";
import { DEMO_CODE, DemoAuth } from "@/lib/accounts/auth";
import {
  DEMO_DECLINE_CARD_ID,
  setAccountStoreForTests,
  setAuthProviderForTests,
} from "@/lib/accounts/registry";
import { MemoryAccountStore } from "@/lib/accounts/store";
import { resetSignInLimitsForTests } from "@/lib/accounts/sign-in";
import { POST as codePOST } from "@/app/api/v1/auth/code/route";
import { POST as verifyPOST } from "@/app/api/v1/auth/verify/route";
import { PUT as defaultPUT } from "@/app/api/v1/cards/default/route";
import { GET as cardsGET } from "@/app/api/v1/cards/route";
import { POST as chargePOST } from "@/app/api/v1/charges/route";
import { POST as stopPOST } from "@/app/api/v1/charges/[id]/stop/route";
import { GET as quoteGET } from "@/app/api/v1/charges/quote/route";
import { GET as activeGET } from "@/app/api/v1/charges/active/route";
import { GET as sessionGET } from "@/app/api/v1/charges/[id]/session/route";
import { GET as receiptGET } from "@/app/api/v1/charges/[id]/receipt/route";
import { POST as receiptEmailPOST } from "@/app/api/v1/charges/[id]/receipt/email/route";
import { GET as historyGET } from "@/app/api/v1/history/route";
import {
  PUT as pushPUT,
  DELETE as pushDELETE,
} from "@/app/api/v1/push-token/route";
import { GET as favouritesGET } from "@/app/api/v1/favourites/route";
import {
  PUT as favouritePUT,
  DELETE as favouriteDELETE,
} from "@/app/api/v1/favourites/[locationId]/route";
import { POST as problemPOST } from "@/app/api/v1/problems/route";
import {
  listProblemsAction,
  resolveProblemAction,
  showProblemAction,
} from "@/app/admin/problems/actions";
import type { CommandEvent } from "@/lib/commands/events";
import { setDriverAppStoreForTests } from "@/lib/driver-app/registry";
import { MemoryDriverAppStore } from "@/lib/driver-app/store";
import {
  DEMO_DECLINE_AT,
  DEMO_KWH_PER_SECOND,
} from "@/lib/driver-app/demo-charging";
import { NO_SESSION_WAIT_MS } from "@/lib/driver-app/charges";
import { DEMO_PEER_ID } from "@/lib/locations/registry";
import { locationAppId } from "@/lib/locations/search";
import { setPeerStoreForTests } from "@/lib/ocpi/registry";
import { MemoryPeerStore } from "@/lib/ocpi/store";
import { demoOutbox } from "@/lib/receipts/mailer";
import { formatAmount, pushText } from "@/lib/push/messages";
import { onCommand, onPayment } from "@/lib/push/notify";
import {
  demoPushOutbox,
  DemoPushOutbox,
  ExpoPushSender,
  pushSender,
  setPushSenderForTests,
} from "@/lib/push/sender";
import { setTokenStoreForTests } from "@/lib/tokens/registry";
import { MemoryTokenStore } from "@/lib/tokens/store";
import {
  inProcessNetwork,
  installNetwork,
  LIVE_ENV,
  uninstallNetwork,
} from "./support/network";

const saved = { ...process.env };
let accounts: MemoryAccountStore;
let app: MemoryDriverAppStore;
let fetchSpy: ReturnType<typeof vi.fn>;
let clock = Date.parse("2026-10-22T09:00:00Z");

const req = (path: string, init: RequestInit & { token?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return new Request(`https://emsp.example.test${path}`, { ...init, headers });
};
const send = (method: string, path: string, body: unknown, token?: string) =>
  req(path, { method, body: JSON.stringify(body), token });
const params = <K extends string>(key: K, value: string) => ({
  params: Promise.resolve({ [key]: value } as Record<K, string>),
});
const tick = (seconds: number) => {
  clock += seconds * 1000;
  vi.setSystemTime(clock);
};

const LOC1 = locationAppId({
  peerId: DEMO_PEER_ID,
  countryCode: "ZZ",
  partyId: "MCK",
  id: "LOC1",
});

async function signIn(email: string) {
  await codePOST(send("POST", "/api/v1/auth/code", { email }));
  const res = await verifyPOST(
    send("POST", "/api/v1/auth/verify", { email, code: DEMO_CODE }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    session: { accessToken: string };
    driver: { id: string };
  };
  return { token: body.session.accessToken, id: body.driver.id };
}

let seq = 0;
async function start(token: string) {
  const res = await chargePOST(
    send(
      "POST",
      "/api/v1/charges",
      {
        requestId: `app-req-${String(++seq).padStart(6, "0")}`,
        locationId: LOC1,
        evseUid: "LOC1-1",
        connectorId: "1",
      },
      token,
    ),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as {
    command: { id: string; status: string };
    payment: { holdAmount: number };
  };
}

const session = async (id: string, token: string) =>
  (await sessionGET(
    req(`/api/v1/charges/${id}/session`, { token }),
    params("id", id),
  ).then((r) => r.json())) as {
    session: {
      status: string;
      open: boolean;
      kwh: number;
      cost: { amount: number } | null;
      stopCode: string | null;
    } | null;
    live: { socPercent?: number };
    payment: {
      status: string;
      stopCode: string | null;
      authorizedAmount: number;
    };
    place: { name: string } | null;
  };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock += 3_600_000;
  vi.setSystemTime(clock);
  for (const k of ["DEMO_MODE", "APP_ORIGINS", "EXPO_ACCESS_TOKEN"])
    delete process.env[k];
  process.env.DEMO_MODE = "true";
  accounts = new MemoryAccountStore();
  app = new MemoryDriverAppStore();
  setAccountStoreForTests(accounts);
  setTokenStoreForTests(new MemoryTokenStore());
  setPeerStoreForTests(new MemoryPeerStore());
  setAuthProviderForTests(new DemoAuth());
  setDriverAppStoreForTests(app);
  resetSignInLimitsForTests();
  clearUserCacheForTests();
  demoPushOutbox().sent.length = 0;
  fetchSpy = vi.fn(() => {
    throw new Error("no network in tests");
  });
  vi.stubGlobal("fetch", fetchSpy);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  setAccountStoreForTests(undefined);
  setTokenStoreForTests(undefined);
  setPeerStoreForTests(undefined);
  setAuthProviderForTests(undefined);
  setDriverAppStoreForTests(undefined);
  setPushSenderForTests(undefined);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.env = { ...saved };
  vi.restoreAllMocks();
});

describe("charging from the app, in demo mode", () => {
  it("quotes, starts, runs, stops, settles and gives a receipt, sending nothing anywhere", async () => {
    const { token } = await signIn("charging.driver@example.com");
    expect(
      (
        await pushPUT(
          send(
            "PUT",
            "/api/v1/push-token",
            {
              token: "ExponentPushToken[abcdefghijklmnop]",
              platform: "ios",
              locale: "de-DE",
            },
            token,
          ),
        )
      ).status,
    ).toBe(200);

    const quote = await (
      await quoteGET(
        req(
          `/api/v1/charges/quote?locationId=${LOC1}&evseUid=LOC1-1&connectorId=1`,
          { token },
        ),
      )
    ).json();
    expect(quote).toMatchObject({
      currency: "EUR",
      holdAmount: 2500,
      demo: true,
      hasCard: true,
    });

    const { command } = await start(token);
    expect(command.status).toBe("succeeded");
    // The demo CPO's session appears at once, linked to the start.
    const active = await (
      await activeGET(req("/api/v1/charges/active", { token }))
    ).json();
    expect(active.charge.command.id).toBe(command.id);
    expect(active.charge.place.name).toBeTruthy();

    tick(30);
    const running = await session(command.id, token);
    expect(running.session).toMatchObject({ status: "ACTIVE", open: true });
    expect(running.session!.kwh).toBeCloseTo(30 * DEMO_KWH_PER_SECOND, 3);
    expect(running.session!.cost!.amount).toBeGreaterThan(0);
    expect(running.live.socPercent).toBeGreaterThan(0);
    // The receipt is not ready while it charges.
    expect(
      (
        await receiptGET(
          req(`/api/v1/charges/${command.id}/receipt`, { token }),
          params("id", command.id),
        )
      ).status,
    ).toBe(409);

    tick(30);
    const stop = await stopPOST(
      send(
        "POST",
        `/api/v1/charges/${command.id}/stop`,
        { requestId: "app-req-stop-1" },
        token,
      ),
      params("id", command.id),
    );
    expect(stop.status).toBe(201);
    expect((await stop.json()).command.status).toBe("succeeded");

    const ended = await session(command.id, token);
    expect(ended.session).toMatchObject({ status: "COMPLETED", open: false });
    expect(ended.payment.status).toBe("captured");
    expect(
      (await (await activeGET(req("/api/v1/charges/active", { token }))).json())
        .charge,
    ).toBeNull();

    const receipt = (
      await (
        await receiptGET(
          req(`/api/v1/charges/${command.id}/receipt`, { token }),
          params("id", command.id),
        )
      ).json()
    ).receipt;
    expect(receipt).toMatchObject({
      chargeId: command.id,
      locationId: LOC1,
      paymentStatus: "captured",
      currency: "EUR",
      stopCode: null,
      demo: true,
    });
    expect(receipt.kwh).toBeCloseTo(60 * DEMO_KWH_PER_SECOND, 3);
    // What was charged is the payment's own figure: the CDR's total, never above the hold.
    expect(receipt.charged).toBe(receipt.sessionCost.amount);
    expect(receipt.charged).toBeLessThanOrEqual(2500);

    const history = await (
      await historyGET(req("/api/v1/history", { token }))
    ).json();
    expect(history.items[0]).toMatchObject({
      chargeId: command.id,
      receipt: true,
      session: { status: "COMPLETED" },
      payment: { status: "captured", charged: receipt.charged },
    });

    const before = demoOutbox().sent.length;
    const emailed = await receiptEmailPOST(
      send("POST", `/api/v1/charges/${command.id}/receipt/email`, {}, token),
      params("id", command.id),
    );
    expect(emailed.status).toBe(202);
    expect(await emailed.json()).toEqual({ sent: false, demo: true });
    expect(demoOutbox().sent.length).toBe(before + 1);
    expect(demoOutbox().sent.at(-1)!.text).toContain("Demo mode");

    // "Charging finished", in the device's language (English fills in), kept in the
    // demo outbox: demo mode sends no push.
    expect(demoPushOutbox().sent).toEqual([
      expect.objectContaining({
        to: "ExponentPushToken[abcdefghijklmnop]",
        title: "Charging finished",
        data: { kind: "charging_done", chargeId: command.id },
      }),
    ]);
    expect(demoPushOutbox().sent[0].body).toContain("6 kWh");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stops at once and says so when the card declines a higher hold", async () => {
    const { token } = await signIn("decline.driver@example.com");
    await pushPUT(
      send(
        "PUT",
        "/api/v1/push-token",
        {
          token: "ExponentPushToken[declinedevice0001]",
          platform: "android",
          locale: "de-DE",
        },
        token,
      ),
    );
    const cards = await (
      await cardsGET(req("/api/v1/cards", { token }))
    ).json();
    expect(cards.cards.map((c: { id: string }) => c.id)).toContain(
      DEMO_DECLINE_CARD_ID,
    );
    expect(
      (
        await defaultPUT(
          send(
            "PUT",
            "/api/v1/cards/default",
            { paymentMethodId: DEMO_DECLINE_CARD_ID },
            token,
          ),
        )
      ).status,
    ).toBe(200);
    const { command } = await start(token);

    tick(5);
    expect((await session(command.id, token)).session!.open).toBe(true);
    // Long enough for the cost to pass the share of the hold the demo card declines at.
    tick(Math.ceil((2500 * DEMO_DECLINE_AT) / 100 / 0.6 / DEMO_KWH_PER_SECOND));
    const stopped = await session(command.id, token);
    expect(stopped.session).toMatchObject({
      status: "COMPLETED",
      stopCode: "hold_increment_declined",
    });
    expect(stopped.payment).toMatchObject({
      status: "captured",
      stopCode: "hold_increment_declined",
    });

    // One push, in German number format, and no "Charging finished" beside it.
    expect(demoPushOutbox().sent).toHaveLength(1);
    expect(demoPushOutbox().sent[0]).toMatchObject({
      title: "Charging stopped",
      body: "Your card didn't approve more charging; session stopped at 25,00\u00a0€.",
      data: { kind: "hold_increment_declined", chargeId: command.id },
    });

    const receipt = (
      await (
        await receiptGET(
          req(`/api/v1/charges/${command.id}/receipt`, { token }),
          params("id", command.id),
        )
      ).json()
    ).receipt;
    expect(receipt.stopCode).toBe("hold_increment_declined");
    expect(receipt.charged).toBeLessThanOrEqual(2500);
    const history = await (
      await historyGET(req("/api/v1/history", { token }))
    ).json();
    expect(history.items[0].stopCode).toBe("hold_increment_declined");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows a driver's charges to that driver only", async () => {
    const a = await signIn("owner.driver@example.com");
    const b = await signIn("someone.else@example.com");
    const { command } = await start(a.token);
    for (const res of [
      await sessionGET(
        req(`/api/v1/charges/${command.id}/session`, { token: b.token }),
        params("id", command.id),
      ),
      await receiptGET(
        req(`/api/v1/charges/${command.id}/receipt`, { token: b.token }),
        params("id", command.id),
      ),
      await receiptEmailPOST(
        send(
          "POST",
          `/api/v1/charges/${command.id}/receipt/email`,
          {},
          b.token,
        ),
        params("id", command.id),
      ),
    ])
      expect(res.status).toBe(404);
    expect(
      (
        await (
          await historyGET(req("/api/v1/history", { token: b.token }))
        ).json()
      ).items,
    ).toEqual([]);
    expect(
      (
        await (
          await activeGET(req("/api/v1/charges/active", { token: b.token }))
        ).json()
      ).charge,
    ).toBeNull();
    // Without a token: 401.
    expect((await historyGET(req("/api/v1/history"))).status).toBe(401);
    // A start the charger took whose session never comes stops counting as active.
    expect(
      (
        await (
          await activeGET(req("/api/v1/charges/active", { token: a.token }))
        ).json()
      ).charge,
    ).not.toBeNull();
    expect(NO_SESSION_WAIT_MS).toBeGreaterThan(0);
  });
});

describe("push notifications", () => {
  const event = (over: Partial<CommandEvent["command"]>): CommandEvent => ({
    type: "command.finished",
    command: {
      id: "11111111-2222-4333-8444-555555555555",
      type: "START_SESSION",
      driverRef: "driver-1",
      status: "failed",
      result: "FAILED",
      requestId: "app-req-000001",
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      ...over,
    },
  });

  it("tells the driver when a start or stop fails, never when the hold was refused", async () => {
    const store = new MemoryDriverAppStore();
    const sender = new DemoPushOutbox();
    await store.putPushToken(
      {
        token: "ExponentPushToken[device00000001]",
        driverRef: "driver-1",
        platform: "ios",
        locale: "en-GB",
      },
      new Date().toISOString(),
    );
    const deps = { store, sender };
    await onCommand(event({}), deps);
    await onCommand(event({ status: "not_supported" }), deps);
    await onCommand(event({ status: "timed_out" }), deps);
    await onCommand(event({ status: "hold_failed" }), deps);
    await onCommand(event({ status: "succeeded" }), deps);
    await onCommand(event({ type: "STOP_SESSION", status: "failed" }), deps);
    await onCommand(
      event({
        type: "STOP_SESSION",
        status: "failed",
        requestId: "hold-declined:abc",
      }),
      deps,
    );
    await onCommand(event({ driverRef: "driver-2" }), deps);
    expect(sender.sent.map((m) => m.data.kind)).toEqual([
      "start_failed",
      "start_not_supported",
      "start_no_answer",
      "stop_failed",
    ]);
    expect(sender.sent[0].data.chargeId).toBe(event({}).command.id);
    expect(sender.sent[3].data.chargeId).toBeUndefined();
    // Words for the driver; a refused start is never put on their card.
    expect(sender.sent[1].body).toBe(
      "This charger doesn't accept app starts. Nothing was charged.",
    );
  });

  it("formats the declined amount for each device's locale and currency", async () => {
    expect(formatAmount(2500, "EUR", "en-IE")).toBe("€25.00");
    expect(formatAmount(2500, "EUR", "de-DE")).toBe("25,00\u00a0€");
    expect(formatAmount(4000, "JPY", "ja-JP")).toBe("￥4,000");
    expect(formatAmount(2500, "GBP", "not a locale!")).toBe("£25.00");
    expect(
      pushText("hold_increment_declined", "fr-FR", { amount: "25,00\u00a0€" }),
    ).toEqual({
      title: "Charging stopped",
      body: "Your card didn't approve more charging; session stopped at 25,00\u00a0€.",
    });
    const store = new MemoryDriverAppStore();
    const sender = new DemoPushOutbox();
    for (const [n, locale] of [
      [1, "en-US"],
      [2, "nl-NL"],
    ] as const)
      await store.putPushToken(
        {
          token: `ExponentPushToken[device0000000${n}]`,
          driverRef: "driver-1",
          platform: "android",
          locale,
        },
        new Date(Date.now() + n).toISOString(),
      );
    await onPayment(
      {
        type: "hold_increment_declined",
        paymentId: "p1",
        commandId: "c1",
        driverRef: "driver-1",
        sessionId: "S1",
        authorizedAmount: 5000,
        currency: "EUR",
        stopReason: "x",
      },
      { store, sender },
    );
    expect(sender.sent.map((m) => m.body)).toHaveLength(2);
    expect(sender.sent.map((m) => m.body)).toEqual(
      expect.arrayContaining([
        "Your card didn't approve more charging; session stopped at €\u00a050,00.",
        "Your card didn't approve more charging; session stopped at €50.00.",
      ]),
    );
  });

  it("sends over Expo's push API with the access token, and forgets devices that are gone", async () => {
    uninstallNetwork();
    const calls: { auth: string | null; body: unknown }[] = [];
    const net = inProcessNetwork({
      "exp.host": async (r) => {
        calls.push({
          auth: r.headers.get("authorization"),
          body: await r.json(),
        });
        return Response.json({
          data: [
            { status: "ok", id: "t1" },
            { status: "error", details: { error: "DeviceNotRegistered" } },
          ],
        });
      },
    });
    installNetwork(net.transport);
    try {
      Object.assign(process.env, LIVE_ENV);
      delete process.env.DEMO_MODE;
      process.env.EXPO_ACCESS_TOKEN = "expo_access_token_0123456789";
      expect(pushSender()).toBeInstanceOf(ExpoPushSender);
      const store = new MemoryDriverAppStore();
      for (const n of [1, 2])
        await store.putPushToken(
          {
            token: `ExponentPushToken[device0000000${n}]`,
            driverRef: "driver-1",
            platform: "ios",
            locale: "en",
          },
          new Date(Date.now() - n).toISOString(),
        );
      await onCommand(event({}), { store, sender: pushSender() });
      expect(calls).toHaveLength(1);
      expect(calls[0].auth).toBe("Bearer expo_access_token_0123456789");
      expect(calls[0].body).toEqual([
        expect.objectContaining({
          to: "ExponentPushToken[device00000001]",
          title: "Charging didn't start",
          data: { kind: "start_failed", chargeId: event({}).command.id },
        }),
        expect.objectContaining({ to: "ExponentPushToken[device00000002]" }),
      ]);
      expect(
        (await store.listPushTokens("driver-1")).map((t) => t.token),
      ).toEqual(["ExponentPushToken[device00000001]"]);
      // Without the access token there is no push in live mode; demo mode has its outbox.
      delete process.env.EXPO_ACCESS_TOKEN;
      expect(pushSender()).toBeNull();
      process.env.DEMO_MODE = "true";
      expect(pushSender()).toBe(demoPushOutbox());
    } finally {
      uninstallNetwork();
    }
  });

  it("saves and forgets a device's token, and refuses anything that is not an Expo token", async () => {
    const { token, id } = await signIn("push.driver@example.com");
    const put = (body: unknown) =>
      pushPUT(send("PUT", "/api/v1/push-token", body, token));
    expect((await put({ token: "not-a-token", platform: "ios" })).status).toBe(
      400,
    );
    expect(
      (
        await put({
          token: "ExponentPushToken[abcdefgh12345678]",
          platform: "web",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await put({
          token: "ExponentPushToken[abcdefgh12345678]",
          platform: "android",
          locale: "<script>",
        })
      ).status,
    ).toBe(200);
    expect(await app.listPushTokens(id)).toEqual([
      expect.objectContaining({ platform: "android", locale: "en" }),
    ]);
    await pushDELETE(
      send(
        "DELETE",
        "/api/v1/push-token",
        { token: "ExponentPushToken[abcdefgh12345678]" },
        token,
      ),
    );
    expect(await app.listPushTokens(id)).toEqual([]);
  });
});

describe("favourites", () => {
  it("adds, lists and removes a driver's favourite locations", async () => {
    const a = await signIn("fav.driver@example.com");
    const b = await signIn("fav.other@example.com");
    const put = (id: string, token: string) =>
      favouritePUT(
        req(`/api/v1/favourites/${id}`, { method: "PUT", token }),
        params("locationId", id),
      );
    expect((await put(LOC1, a.token)).status).toBe(200);
    expect((await put(LOC1, a.token)).status).toBe(200);
    expect((await put("bm90LWEtbG9jYXRpb24", a.token)).status).toBe(404);
    const mine = await (
      await favouritesGET(req("/api/v1/favourites", { token: a.token }))
    ).json();
    expect(mine.favourites).toEqual([
      expect.objectContaining({
        locationId: LOC1,
        place: expect.objectContaining({ id: LOC1 }),
      }),
    ]);
    expect(
      (
        await (
          await favouritesGET(req("/api/v1/favourites", { token: b.token }))
        ).json()
      ).favourites,
    ).toEqual([]);
    await favouriteDELETE(
      req(`/api/v1/favourites/${LOC1}`, { method: "DELETE", token: a.token }),
      params("locationId", LOC1),
    );
    expect(
      (
        await (
          await favouritesGET(req("/api/v1/favourites", { token: a.token }))
        ).json()
      ).favourites,
    ).toEqual([]);
  });
});

describe("report a problem", () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString(
    "base64",
  );
  const report = (body: Record<string, unknown>, token: string) =>
    problemPOST(send("POST", "/api/v1/problems", body, token));
  const form = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };

  it("takes a report with a photo, checks it, and shows it to admins", async () => {
    const { token, id } = await signIn("report.driver@example.com");
    const ok = {
      locationId: LOC1,
      evseUid: "LOC1-1",
      category: "damaged",
      message: "  The cable is cut.\u0007 ",
      photo: JPEG,
    };
    const bad: [Record<string, unknown>, number][] = [
      [{ ...ok, category: "angry" }, 400],
      [{ ...ok, message: "   " }, 400],
      [{ ...ok, message: "x".repeat(2001) }, 400],
      [{ ...ok, locationId: "nope" }, 404],
      [{ ...ok, photo: Buffer.from("<svg/>").toString("base64") }, 400],
      [{ ...ok, photo: "not base64!" }, 400],
      [
        {
          ...ok,
          photo: Buffer.concat([
            Buffer.from([0xff, 0xd8, 0xff]),
            Buffer.alloc(1_000_001),
          ]).toString("base64"),
        },
        413,
      ],
    ];
    for (const [body, status] of bad)
      expect((await report(body, token)).status).toBe(status);
    const res = await report(ok, token);
    expect(res.status).toBe(201);
    const { id: reportId } = await res.json();
    expect(await app.getReport(reportId)).toMatchObject({
      driverRef: id,
      category: "damaged",
      message: "The cable is cut.",
      photoType: "image/jpeg",
      status: "open",
    });

    process.env.ADMIN_SECRET = "a".repeat(40);
    const secret = { adminSecret: "a".repeat(40) };
    const list = await listProblemsAction(
      {},
      form({ ...secret, status: "open" }),
    );
    expect(list).toMatchObject({
      ok: true,
      reports: [
        expect.objectContaining({
          id: reportId,
          hasPhoto: true,
          location: "ZZ/MCK/LOC1",
        }),
      ],
    });
    const shown = await showProblemAction({}, form({ ...secret, reportId }));
    expect(shown.report!.photo).toBe(`data:image/jpeg;base64,${JPEG}`);
    expect(
      (await resolveProblemAction({}, form({ ...secret, reportId }))).ok,
    ).toBe(true);
    expect(
      (await resolveProblemAction({}, form({ ...secret, reportId }))).ok,
    ).toBe(false);
    expect(await app.getReport(reportId)).toMatchObject({
      status: "resolved",
      resolvedBy: "admin:secret",
    });
    // Without the secret or an admin session, nothing.
    expect((await listProblemsAction({}, form({ status: "open" }))).ok).toBe(
      false,
    );
  });

  it("takes at most ten reports a day from a driver", async () => {
    const { token } = await signIn("busy.reporter@example.com");
    for (let i = 0; i < 10; i++)
      expect(
        (
          await report(
            { locationId: LOC1, category: "other", message: `Report ${i}` },
            token,
          )
        ).status,
      ).toBe(201);
    expect(
      (
        await report(
          { locationId: LOC1, category: "other", message: "One more" },
          token,
        )
      ).status,
    ).toBe(429);
  });
});
