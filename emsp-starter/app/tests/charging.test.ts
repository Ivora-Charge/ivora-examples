import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "../src/i18n/core";
import {
  emailReceipt,
  getActiveCharge,
  getCards,
  getChargeSession,
  getHistory,
  getReceipt,
  reportProblem,
  SAMPLE_LOCATIONS,
  savePushToken,
  setFavourite,
  startCharge,
  stopCharge,
} from "../src/lib/api";
import {
  oneRequest,
  outcomeUnknown,
  phaseOf,
  requestId,
  startProblem,
  type CommandView,
} from "../src/lib/charging";
import {
  createDemoCharging,
  DEMO_DECLINE_AT,
  DEMO_DECLINE_CARD_ID,
  DEMO_HOLD,
  DEMO_KWH_PER_SECOND,
} from "../src/lib/demo-charge";
import { chargerCode, evseForCode } from "../src/lib/qr";

const station = SAMPLE_LOCATIONS.find((l) => l.name === "Station Square")!;
const evse = station.evses[0];

describe("charger codes from a QR code or the keyboard", () => {
  it("reads a bare EVSE ID, a link with one, or a charger reference", () => {
    expect(chargerCode(" ZZ*MCK*E11 ")).toBe("ZZ*MCK*E11");
    expect(
      chargerCode("https://charge.example.test/start?evse=ZZ*MCK*E11"),
    ).toBe("ZZ*MCK*E11");
    expect(chargerCode("https://charge.example.test/c/ZZMCKE11")).toBe(
      "ZZMCKE11",
    );
    expect(chargerCode("https://x.example.test/?evse_id=ZZ%2AMCK%2AE11")).toBe(
      "ZZ*MCK*E11",
    );
    expect(chargerCode("A1")).toBe("A1");
    for (const bad of ["", " ", "<script>", "x", "https://x.example.test/"])
      expect(chargerCode(bad)).toBeNull();
  });

  it("finds the EVSE a code names, whatever its separators and case", () => {
    expect(evseForCode(station.evses, "zz-mck-e11")?.uid).toBe(evse.uid);
    expect(evseForCode(station.evses, "nothing")).toBeUndefined();
  });
});

describe("the offline demo's charging", () => {
  let now = Date.parse("2026-10-22T09:00:00Z");
  const clock = () => now;

  it("starts once per request, rises, stops and settles never above the hold", () => {
    const demo = createDemoCharging(SAMPLE_LOCATIONS, clock);
    const input = {
      requestId: "app-req-0001",
      locationId: station.id,
      evseUid: evse.uid,
      connectorId: evse.connectors[0].id,
    };
    const first = demo.start(input);
    expect(first.state).toBe("created");
    expect(first.command).toMatchObject({
      status: "succeeded",
      pending: false,
    });
    expect(first.command.peerMessage).toContain("Demo mode");
    // The same request again is the same start; another one while it runs is busy.
    expect(demo.start(input).state).toBe("replayed");
    expect(demo.start({ ...input, requestId: "app-req-0002" }).state).toBe(
      "busy",
    );

    now += 60_000;
    const running = demo.session(first.command.id);
    expect(running.session).toMatchObject({ status: "ACTIVE", open: true });
    expect(running.session!.kwh).toBeCloseTo(60 * DEMO_KWH_PER_SECOND, 4);
    expect(running.live.socPercent).toBeGreaterThan(0);
    expect(demo.active()?.command.id).toBe(first.command.id);
    expect(() => demo.receipt(first.command.id)).toThrow(/not ready/);

    demo.stop(first.command.id);
    now += 60_000; // time passes after the stop: nothing more is counted
    const done = demo.session(first.command.id);
    expect(done.session).toMatchObject({ status: "COMPLETED", open: false });
    expect(done.payment).toMatchObject({ status: "captured", demo: true });
    expect(demo.active()).toBeNull();
    const receipt = demo.receipt(first.command.id);
    expect(receipt.kwh).toBeCloseTo(60 * DEMO_KWH_PER_SECOND, 4);
    expect(receipt.charged).toBe(
      Math.min(receipt.sessionCost.amount, DEMO_HOLD),
    );
    expect(receipt.locationId).toBe(station.id);
    expect(demo.history()[0]).toMatchObject({
      chargeId: first.command.id,
      receipt: true,
      stopCode: null,
    });
  });

  it("stops by itself, and says why, when the card declines a higher hold", () => {
    const demo = createDemoCharging(SAMPLE_LOCATIONS, clock);
    demo.setDefaultCard(DEMO_DECLINE_CARD_ID);
    expect(demo.cards().find((c) => c.isDefault)?.last4).toBe("0341");
    const { command } = demo.start({
      requestId: "app-req-0003",
      locationId: station.id,
      evseUid: evse.uid,
    });
    now += 5_000;
    expect(demo.session(command.id).session!.open).toBe(true);
    now += 10 * 60_000;
    const stopped = demo.session(command.id);
    expect(stopped.session).toMatchObject({
      open: false,
      stopCode: "hold_increment_declined",
    });
    // Stopped when the cost reached the share of the hold, not ten minutes later.
    expect(stopped.session!.cost!.amount).toBeGreaterThanOrEqual(
      DEMO_HOLD * DEMO_DECLINE_AT,
    );
    expect(stopped.session!.cost!.amount).toBeLessThan(
      DEMO_HOLD * DEMO_DECLINE_AT + 50,
    );
    expect(stopped.payment).toMatchObject({
      stopCode: "hold_increment_declined",
      authorizedAmount: DEMO_HOLD,
    });
    expect(demo.receipt(command.id).stopCode).toBe("hold_increment_declined");
    expect(demo.history()[0].stopCode).toBe("hold_increment_declined");
  });

  it("keeps favourites and reports on the device", () => {
    const demo = createDemoCharging(SAMPLE_LOCATIONS, clock);
    demo.setFavourite(station.id, true);
    demo.setFavourite(station.id, true);
    expect(demo.favourites().map((f) => f.place?.name)).toEqual([
      "Station Square",
    ]);
    demo.setFavourite(station.id, false);
    expect(demo.favourites()).toEqual([]);
    expect(() => demo.setFavourite("nope", true)).toThrow();
    demo.report({
      locationId: station.id,
      category: "damaged",
      message: "Cable cut",
    });
    expect(demo.reports()).toHaveLength(1);
    expect(() => demo.removeCard()).toThrow(/cannot be removed/);
  });
});

describe("the charging API", () => {
  const saved = { ...process.env };
  let fetchSpy: ReturnType<typeof vi.fn>;
  const TOKEN = "access-token-0123456789";

  beforeEach(() => {
    delete process.env.EXPO_PUBLIC_API_URL;
    delete process.env.EXPO_PUBLIC_DEMO_MODE;
    fetchSpy = vi.fn(() => {
      throw new Error("offline demo must not call fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  it("runs the whole flow offline, sending nothing anywhere", async () => {
    expect((await getCards(TOKEN)).map((c) => c.last4)).toEqual([
      "4242",
      "0341",
    ]);
    const { command } = await startCharge(TOKEN, {
      requestId: requestId(),
      locationId: station.id,
      evseUid: evse.uid,
    });
    expect((await getActiveCharge(TOKEN))?.command.id).toBe(command.id);
    expect((await getChargeSession(TOKEN, command.id)).session?.open).toBe(
      true,
    );
    await stopCharge(TOKEN, command.id, requestId());
    expect((await getReceipt(TOKEN, command.id)).demo).toBe(true);
    expect(await emailReceipt(TOKEN, command.id)).toEqual({
      sent: false,
      demo: true,
    });
    expect((await getHistory(TOKEN))[0].chargeId).toBe(command.id);
    await setFavourite(TOKEN, station.id, true);
    await reportProblem(TOKEN, {
      locationId: station.id,
      category: "other",
      message: "x",
    });
    // The offline demo has no server to notify: no push token leaves the device.
    await savePushToken(TOKEN, {
      token: "ExponentPushToken[abcdefgh12345678]",
      platform: "ios",
      locale: "en",
    });
    await expect(getReceipt(TOKEN, "nope")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("asks only its own server, with the driver's token, when a URL is set", async () => {
    process.env.EXPO_PUBLIC_API_URL = "https://emsp.example.test";
    fetchSpy.mockImplementation(async () =>
      Response.json({ command: { id: "c1" }, payment: null, state: "created" }),
    );
    await startCharge(TOKEN, {
      requestId: "app-req-0009",
      locationId: "LOC",
      evseUid: "E1",
      connectorId: "1",
    });
    await setFavourite(TOKEN, "a/b", false);
    await stopCharge(TOKEN, "c1", "app-req-0010");
    const calls = fetchSpy.mock.calls.map(([url, init]) => [
      url,
      (init as RequestInit).method,
      ((init as RequestInit).headers as Record<string, string>).Authorization,
    ]);
    expect(calls).toEqual([
      ["https://emsp.example.test/api/v1/charges", "POST", `Bearer ${TOKEN}`],
      [
        "https://emsp.example.test/api/v1/favourites/a%2Fb",
        "DELETE",
        `Bearer ${TOKEN}`,
      ],
      [
        "https://emsp.example.test/api/v1/charges/c1/stop",
        "POST",
        `Bearer ${TOKEN}`,
      ],
    ]);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
      requestId: "app-req-0009",
      locationId: "LOC",
      evseUid: "E1",
      connectorId: "1",
    });
    fetchSpy.mockImplementation(
      async () => new Response("{}", { status: 409 }),
    );
    await expect(getReceipt(TOKEN, "c1")).rejects.toMatchObject({
      code: "http_409",
    });
  });

  /**
   * A server like ours: one command per request ID, a hold for each new start, and a
   * replay (no hold, nothing sent) for an ID it has seen. `script` decides each answer.
   */
  function fakeServer(
    script: (call: number) => "ok" | "lost" | "refuse" | "error" | "fail",
  ) {
    const seen = new Map<string, string>();
    const holds: string[] = [];
    const commands: string[] = [];
    let call = 0;
    fetchSpy.mockImplementation(async (url: string, init: RequestInit) => {
      const step = script(call++);
      if (step === "refuse") return Response.json({}, { status: 409 });
      if (step === "error") return Response.json({}, { status: 503 });
      const { requestId: id } = JSON.parse(String(init.body));
      const type = url.endsWith("/stop") ? "STOP_SESSION" : "START_SESSION";
      let state = "replayed";
      if (!seen.has(id)) {
        seen.set(id, `cmd-${seen.size + 1}`);
        if (type === "START_SESSION") holds.push(id);
        commands.push(type);
        state = "created";
      }
      // The server acted, then the answer never reached the phone.
      if (step === "lost") throw new TypeError("Network request failed");
      const command = {
        id: seen.get(id),
        type,
        requestId: id,
        status: step === "fail" ? "failed" : "accepted",
        pending: step !== "fail",
        result: step === "fail" ? "REJECTED" : null,
      };
      return Response.json({ state, command, payment: null });
    });
    return { holds, commands, seen };
  }

  const startInput = { locationId: "LOC", evseUid: "E1", connectorId: "1" };
  const startOver = (r: Awaited<ReturnType<typeof startCharge>>) =>
    startProblem(r.command) !== null;

  it("retries a start whose answer was lost with the same request ID: one start, one hold", async () => {
    process.env.EXPO_PUBLIC_API_URL = "https://emsp.example.test";
    const server = fakeServer((n) => (n === 0 ? "lost" : "ok"));
    const request = oneRequest();
    const send = () =>
      request.send(
        (requestId) => startCharge(TOKEN, { requestId, ...startInput }),
        startOver,
      );
    await expect(send()).rejects.toMatchObject({ code: "unreachable" });
    const res = await send();
    expect(res.state).toBe("replayed");
    expect(server.holds).toHaveLength(1);
    expect(server.commands).toEqual(["START_SESSION"]);
  });

  it("keeps the request ID after a server error, and makes a new one after a refusal or a failed start", async () => {
    process.env.EXPO_PUBLIC_API_URL = "https://emsp.example.test";
    const steps = ["error", "refuse", "fail", "ok"] as const;
    const server = fakeServer((n) => steps[n]);
    const request = oneRequest();
    const send = () =>
      request.send(
        (requestId) => startCharge(TOKEN, { requestId, ...startInput }),
        startOver,
      );
    const ids: string[] = [];
    const sent = () =>
      JSON.parse(fetchSpy.mock.calls.at(-1)![1].body).requestId as string;
    await expect(send()).rejects.toMatchObject({ code: "http_503" });
    ids.push(sent());
    await expect(send()).rejects.toMatchObject({ code: "http_409" });
    ids.push(sent());
    expect((await send()).command.status).toBe("failed");
    ids.push(sent());
    expect((await send()).state).toBe("created");
    ids.push(sent());
    // 503 kept it; the 409 refusal and the failed start each ended it.
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[1]);
    expect(ids[3]).not.toBe(ids[2]);
    expect(server.holds).toEqual([ids[2], ids[3]]);
  });

  it("treats a stop the same way: a lost answer is retried with the same ID", async () => {
    process.env.EXPO_PUBLIC_API_URL = "https://emsp.example.test";
    const server = fakeServer((n) =>
      n === 0 ? "lost" : n === 1 ? "ok" : "refuse",
    );
    const request = oneRequest();
    const failed = (r: Awaited<ReturnType<typeof stopCharge>>) =>
      !r.command.pending && r.command.status !== "succeeded";
    const send = () =>
      request.send((id) => stopCharge(TOKEN, "c1", id), failed);
    await expect(send()).rejects.toMatchObject({ code: "unreachable" });
    const first = request.id;
    expect((await send()).state).toBe("replayed");
    expect(server.commands).toEqual(["STOP_SESSION"]);
    expect(request.id).toBe(first);
    await expect(send()).rejects.toMatchObject({ code: "http_409" });
    expect(request.id).not.toBe(first);
  });

  it("knows which errors leave the outcome unknown", () => {
    const api = (code: string) =>
      Object.assign(new Error(code), { name: "ApiError", code });
    for (const code of [
      "unreachable",
      "rate_limited",
      "http_408",
      "http_500",
      "http_504",
    ])
      expect(outcomeUnknown(api(code))).toBe(true);
    for (const code of [
      "invalid",
      "unauthorized",
      "not_found",
      "http_403",
      "http_409",
    ])
      expect(outcomeUnknown(api(code))).toBe(false);
    // An answer we could not read: the server may have acted.
    expect(outcomeUnknown(new SyntaxError("bad json"))).toBe(true);
  });
});

describe("words and formats for charging", () => {
  const command = (over: Partial<CommandView>): CommandView => ({
    id: "c1",
    type: "START_SESSION",
    requestId: "r",
    status: "succeeded",
    pending: false,
    result: "ACCEPTED",
    message: "",
    peerMessage: null,
    alternatives: [],
    sessionId: null,
    createdAt: "",
    finishedAt: null,
    ...over,
  });

  it("tells a refused card from a charger fault", () => {
    expect(startProblem(command({ status: "hold_failed", result: null }))).toBe(
      "card",
    );
    expect(startProblem(command({ status: "not_supported" }))).toBe(
      "notSupported",
    );
    expect(
      startProblem(command({ status: "failed", result: "EVSE_OCCUPIED" })),
    ).toBe("occupied");
    expect(startProblem(command({ status: "timed_out" }))).toBe("timedOut");
    expect(
      startProblem(command({ pending: true, status: "accepted" })),
    ).toBeNull();
    expect(startProblem(command({}))).toBeNull();
  });

  it("follows a charge from starting to finished", () => {
    const open = { session: { open: true } as never };
    expect(phaseOf({ command: command({ pending: true }) }, null, false)).toBe(
      "starting",
    );
    expect(phaseOf({ command: command({}) }, null, false)).toBe("starting");
    expect(phaseOf({ command: command({}) }, open, false)).toBe("charging");
    expect(phaseOf({ command: command({}) }, open, true)).toBe("stopping");
    expect(
      phaseOf(
        { command: command({}) },
        { session: { open: false } as never },
        true,
      ),
    ).toBe("finished");
    expect(
      phaseOf({ command: command({ status: "failed" }) }, null, false),
    ).toBe("failed");
  });

  it("formats minor units, energy and time for the locale, and the declined hold in words", () => {
    const en = createI18n("en-IE");
    const de = createI18n("de-DE");
    expect(en.minor(2500, "EUR")).toBe("€25.00");
    expect(de.minor(2500, "EUR").replace(/\s/g, " ")).toBe("25,00 €");
    expect(createI18n("ja-JP").minor(4000, "JPY")).toBe("￥4,000");
    expect(en.kwh(12.3456)).toBe("12.35 kWh");
    expect(de.kwh(12.3456)).toBe("12,35 kWh");
    expect(en.duration(45 * 60)).toBe("45 min");
    expect(en.duration(20)).toBe("under 1 min");
    expect(en.duration(65 * 60 + 30)).toBe("1 h 05 min");
    expect(en.t("charge.declined", { amount: en.minor(2500, "EUR") })).toBe(
      "Your card didn't approve more charging; session stopped at €25.00.",
    );
    // Never in words that blame the charger.
    expect(en.t("charge.declined", { amount: "" })).not.toMatch(
      /charger|fault|error/i,
    );
  });
});
