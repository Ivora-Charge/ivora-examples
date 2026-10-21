import { afterEach, describe, expect, it, vi } from "vitest";
import {
  POS_EVENT_HEADER,
  POS_SIGNATURE_HEADER,
  sessionDueBody,
  sessionDuePayload,
  signPosBody,
  verifyPosSignature,
} from "@/lib/pos";
import { receiptEmail, isEmailAddress } from "@/lib/receipt-email";
import { readSettings } from "@/lib/settings";
import type { SaleDueEvent, SaleView } from "@/lib/store";
import { deliverReceipt, type ReceiptMailer } from "@/lib/server/mailer";
import { bearerMatches, RateLimiter } from "@/lib/server/pos";
import {
  POS_ATTEMPT_DELAYS_MS,
  POS_RUN_BACKOFF_MS,
  POS_SENDING_STALE_MS,
  PosOutbox,
} from "@/lib/server/pos-webhook";
import { posOutbox, receiptMailer } from "@/lib/server/services";

const SECRET = "whsec_test_only";
const T0 = Date.parse("2026-10-20T15:30:00Z");

const EVENT: SaleDueEvent = {
  id: "post-3fa9c01b77de:due",
  type: "sale.due",
  sale: "post-3fa9c01b77de",
  charger: { code: "PUMP-3", connector: 1, label: "Charger 3" },
  mode: "postpay",
  amountDueCents: 1940,
  changeDueCents: 0,
  currency: "USD",
  energyWh: 36_042,
  startedAt: "2026-10-20T15:00:00Z",
  endedAt: "2026-10-20T15:30:00.000Z",
};

describe("session_due payload", () => {
  it("carries the sale, charger, money, energy and UTC times, and nothing personal", () => {
    expect(sessionDuePayload(EVENT)).toEqual({
      id: "post-3fa9c01b77de:due",
      type: "session_due",
      sale_id: "post-3fa9c01b77de",
      charger_code: "PUMP-3",
      connector: 1,
      charger_label: "Charger 3",
      mode: "postpay",
      amount_due_minor: 1940,
      change_due_minor: 0,
      currency: "USD",
      energy_kwh: "36.042",
      started_at: "2026-10-20T15:00:00.000Z",
      ended_at: "2026-10-20T15:30:00.000Z",
    });
    // The same event always serialises to the same bytes.
    expect(sessionDueBody({ ...EVENT })).toBe(sessionDueBody(EVENT));
  });
});

describe("POS webhook signature", () => {
  const body = sessionDueBody(EVENT);
  const t = Math.floor(T0 / 1000);

  it("signs <t>.<raw body> with HMAC-SHA256, like Ivora-Signature", () => {
    const header = signPosBody(SECRET, body, t);
    expect(header).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
    expect(verifyPosSignature(SECRET, header, body, T0)).toBe("ok");
    // Known vector, so a POS in any language can check its own code.
    // printf '%s' '1700000000.{}' | openssl dgst -sha256 -hmac secret
    expect(signPosBody("secret", "{}", 1700000000)).toBe(
      "t=1700000000,v1=b8569b78799ff9e3cbff0fc2d63a33a2b57f3282abd07c37ae5e8e7d79a5f163",
    );
  });

  it("refuses a changed body, another secret, a stale or a malformed header", () => {
    const header = signPosBody(SECRET, body, t);
    expect(
      verifyPosSignature(SECRET, header, body.replace("1940", "1"), T0),
    ).toBe("invalid");
    expect(verifyPosSignature("other", header, body, T0)).toBe("invalid");
    expect(verifyPosSignature(SECRET, header, body, T0 + 6 * 60_000)).toBe(
      "stale",
    );
    expect(verifyPosSignature(SECRET, "v1=abc", body, T0)).toBe("invalid");
    expect(verifyPosSignature(SECRET, null, body, T0)).toBe("invalid");
  });
});

type Sent = { url: string; headers: Record<string, string>; body: string };

function outbox(statuses: (number | "network")[], start = T0) {
  let now = start;
  const sent: Sent[] = [];
  const sleeps: number[] = [];
  const tasks: Promise<void>[] = [];
  const queue = [...statuses];
  const box = new PosOutbox({
    url: "https://pos.example.com/hook",
    secret: SECRET,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    schedule: (task) => void tasks.push(task()),
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({
        url,
        headers: init.headers as Record<string, string>,
        body: init.body as string,
      });
      const next = queue.shift() ?? 200;
      if (next === "network") throw new TypeError("fetch failed");
      return new Response(null, { status: next });
    }) as unknown as typeof fetch,
  });
  return {
    box,
    sent,
    sleeps,
    settle: () => Promise.all(tasks.splice(0)),
    advance: (ms: number) => (now += ms),
  };
}

describe("POS webhook delivery", () => {
  it("sends each event once per instance, however often the sale is read", async () => {
    const o = outbox([200]);
    for (let i = 0; i < 5; i++) o.box.offer(EVENT);
    await o.settle();
    o.box.offer(EVENT);
    await o.settle();
    expect(o.sent).toHaveLength(1);
    const [only] = o.sent;
    expect(only.url).toBe("https://pos.example.com/hook");
    expect(only.headers[POS_EVENT_HEADER]).toBe(EVENT.id);
    expect(
      verifyPosSignature(
        SECRET,
        only.headers[POS_SIGNATURE_HEADER],
        only.body,
        T0,
      ),
    ).toBe("ok");
    expect(JSON.parse(only.body)).toMatchObject({
      type: "session_due",
      sale_id: EVENT.sale,
      amount_due_minor: 1940,
    });
  });

  it("retries with backoff, with the same event ID and body and a fresh signature", async () => {
    const o = outbox([503, "network", 200]);
    o.box.offer(EVENT);
    await o.settle();
    expect(o.sent).toHaveLength(3);
    expect(o.sleeps).toEqual(POS_ATTEMPT_DELAYS_MS.filter(Boolean));
    expect(new Set(o.sent.map((s) => s.body)).size).toBe(1);
    expect(new Set(o.sent.map((s) => s.headers[POS_EVENT_HEADER]))).toEqual(
      new Set([EVENT.id]),
    );
    const stamps = o.sent.map(
      (s) => /t=(\d+)/.exec(s.headers[POS_SIGNATURE_HEADER])![1],
    );
    expect(new Set(stamps).size).toBe(3);
    o.box.offer(EVENT);
    await o.settle();
    expect(o.sent).toHaveLength(3); // delivered: never again
  });

  it("waits a growing backoff between failed runs, then gives up", async () => {
    const attempts = POS_ATTEMPT_DELAYS_MS.length;
    const o = outbox(
      Array(attempts * (POS_RUN_BACKOFF_MS.length + 1)).fill(500),
    );
    o.box.offer(EVENT);
    await o.settle();
    expect(o.sent).toHaveLength(attempts);
    for (const [i, wait] of POS_RUN_BACKOFF_MS.entries()) {
      o.advance(wait - 1);
      o.box.offer(EVENT); // too soon
      await o.settle();
      expect(o.sent).toHaveLength(attempts * (i + 1));
      o.advance(1);
      o.box.offer(EVENT);
      await o.settle();
      expect(o.sent).toHaveLength(attempts * (i + 2));
    }
    o.advance(24 * 60 * 60_000);
    o.box.offer(EVENT);
    await o.settle();
    expect(o.sent).toHaveLength(attempts * (POS_RUN_BACKOFF_MS.length + 1));
  });

  it("doesn't retry a request the POS refuses (4xx other than 408 or 429)", async () => {
    const o = outbox([400]);
    o.box.offer(EVENT);
    await o.settle();
    o.advance(24 * 60 * 60_000);
    o.box.offer(EVENT);
    await o.settle();
    expect(o.sent).toHaveLength(1);
    const limited = outbox([429, 200]);
    limited.box.offer(EVENT);
    await limited.settle();
    expect(limited.sent).toHaveLength(2);
  });

  it("retries a run cut off mid-send once it's stale, not while it may still be running", async () => {
    let now = T0;
    const sent: string[] = [];
    let respond = true;
    const box = new PosOutbox({
      url: "https://pos.example.com/hook",
      secret: SECRET,
      now: () => now,
      sleep: async () => {},
      // Like after() when the route hits its time limit: the first run never ends.
      schedule: (task) => void task(),
      fetch: (async (_url: string, init: RequestInit) => {
        sent.push(init.body as string);
        if (!respond) return new Promise<Response>(() => {});
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
    });
    respond = false;
    box.offer(EVENT);
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    respond = true;
    now += POS_SENDING_STALE_MS - 1;
    box.offer(EVENT);
    expect(box.retryDue()).toBe(0);
    expect(sent).toHaveLength(1);
    now += 1;
    box.offer(EVENT);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(2);
    expect(new Set(sent).size).toBe(1); // the same event and body
    now += 24 * 60 * 60_000;
    box.offer(EVENT);
    expect(box.retryDue()).toBe(0);
    expect(sent).toHaveLength(2); // delivered: never again
  });

  it("lets the sweep retry due events without the sale being read again", async () => {
    const o = outbox([500, 500, 500, 200]);
    o.box.offer(EVENT);
    await o.settle();
    expect(o.sent).toHaveLength(POS_ATTEMPT_DELAYS_MS.length);
    expect(o.box.retryDue()).toBe(0); // backoff not over yet
    o.advance(POS_RUN_BACKOFF_MS[0]);
    expect(o.box.retryDue()).toBe(1);
    await o.settle();
    expect(o.sent).toHaveLength(POS_ATTEMPT_DELAYS_MS.length + 1);
    o.advance(24 * 60 * 60_000);
    expect(o.box.retryDue()).toBe(0);
    o.box.offer(EVENT);
    await o.settle();
    expect(o.sent).toHaveLength(POS_ATTEMPT_DELAYS_MS.length + 1);
  });

  it("lets the sweep pick up a stale send, and ignores the late result of the run it replaced", async () => {
    let now = T0;
    const hanging: ((r: Response) => void)[] = [];
    const plan: ("hang" | number)[] = ["hang", "hang", 500, 500];
    const box = new PosOutbox({
      url: "https://pos.example.com/hook",
      secret: SECRET,
      now: () => now,
      sleep: async () => {},
      schedule: (task) => void task(),
      fetch: (() => {
        const next = plan.shift() ?? 200;
        if (next === "hang")
          return new Promise<Response>((r) => hanging.push(r));
        return Promise.resolve(new Response(null, { status: next }));
      }) as unknown as typeof fetch,
    });
    box.offer(EVENT); // run 1 hangs
    now += POS_SENDING_STALE_MS;
    expect(box.retryDue()).toBe(1); // run 2 hangs too
    expect(hanging).toHaveLength(2);
    // Run 1 comes back late and fails. Run 2 is still the one in charge: no
    // backoff from run 1's result, so run 2 is retried when it goes stale.
    now += 30_000;
    hanging[0](new Response(null, { status: 500 }));
    await new Promise((r) => setTimeout(r, 0));
    now += POS_SENDING_STALE_MS - 30_000 - 1;
    expect(box.retryDue()).toBe(0);
    now += 1;
    expect(box.retryDue()).toBe(1); // run 3 delivers
    await new Promise((r) => setTimeout(r, 0));
    // Run 2's late failure doesn't undo the delivery.
    hanging[1](new Response(null, { status: 500 }));
    await new Promise((r) => setTimeout(r, 0));
    now += 24 * 60 * 60_000;
    expect(box.retryDue()).toBe(0);
    box.offer(EVENT);
    expect(plan).toEqual([]);
  });

  it("gives up on an event whose runs keep getting cut off", () => {
    let now = T0;
    let fetches = 0;
    const log = vi.fn();
    const box = new PosOutbox({
      url: "https://pos.example.com/hook",
      secret: SECRET,
      now: () => now,
      schedule: (task) => void task(),
      log,
      fetch: (() => {
        fetches += 1;
        return new Promise<Response>(() => {});
      }) as unknown as typeof fetch,
    });
    box.offer(EVENT);
    for (let i = 0; i < POS_RUN_BACKOFF_MS.length + 3; i++) {
      now += POS_SENDING_STALE_MS;
      box.retryDue();
    }
    expect(fetches).toBe(POS_RUN_BACKOFF_MS.length + 1);
    expect(log).toHaveBeenCalledWith("pos webhook gave up", {
      event: EVENT.id,
      result: "failed",
    });
  });

  it("is off in demo mode, even with a URL and secret set", () => {
    vi.stubEnv("POS_WEBHOOK_SECRET", SECRET);
    const demo = readSettings({
      DEMO_MODE: "1",
      POS_WEBHOOK_URL: "https://pos.example.com/hook",
    });
    expect(demo.posWebhookUrl).toBe("");
    expect(posOutbox(demo)).toBeNull();
  });

  it("only posts to HTTPS, and never with credentials in the URL", () => {
    const live = {
      IVORA_API_KEY: "k",
      IVORA_TENANT_ID: "1",
      STRIPE_SECRET_KEY: "s",
      SESSION_SECRET: "x",
      OPERATOR_PASSWORD: "p",
      PUBLIC_BASE_URL: "https://charge.example.com",
    };
    expect(
      readSettings({ ...live, POS_WEBHOOK_URL: "https://pos.example.com/h" })
        .posWebhookUrl,
    ).toBe("https://pos.example.com/h");
    expect(() =>
      readSettings({ ...live, POS_WEBHOOK_URL: "http://pos.example.com/h" }),
    ).toThrow(/HTTPS/);
    expect(() =>
      readSettings({ ...live, POS_WEBHOOK_URL: "https://u:p@pos.example.com" }),
    ).toThrow(/credentials/);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POS API authentication", () => {
  it("needs exactly `Bearer <POS_API_SECRET>`", () => {
    expect(bearerMatches("Bearer pos_secret_1", "pos_secret_1")).toBe(true);
    expect(bearerMatches("Bearer pos_secret_2", "pos_secret_1")).toBe(false);
    expect(bearerMatches("pos_secret_1", "pos_secret_1")).toBe(false);
    expect(bearerMatches("Bearer pos_secret_1x", "pos_secret_1")).toBe(false);
    expect(bearerMatches(null, "pos_secret_1")).toBe(false);
    expect(bearerMatches("Bearer ", "")).toBe(false); // no secret: always off
  });

  it("rate-limits each client per window", () => {
    const limit = new RateLimiter(2, 60_000);
    expect([1, 2, 3].map(() => limit.allow("a", T0))).toEqual([
      true,
      true,
      false,
    ]);
    expect(limit.allow("b", T0)).toBe(true);
    expect(limit.allow("a", T0 + 60_001)).toBe(true);
  });
});

describe("POS routes", () => {
  const live = {
    IVORA_API_KEY: "k",
    IVORA_TENANT_ID: "1",
    STRIPE_SECRET_KEY: "s",
    SESSION_SECRET: "x",
    OPERATOR_PASSWORD: "p",
    CASHIER_PASSWORD: "c",
    PUBLIC_BASE_URL: "https://charge.example.com",
    DEMO_MODE: "",
  };
  const stub = (env: Record<string, string>) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  };
  const post = (auth: string | null, body: unknown, ip: string) =>
    new Request("https://charge.example.com/api/pos/mark-paid", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": ip,
        ...(auth ? { authorization: auth } : {}),
      },
      body: JSON.stringify(body),
    });

  it("are off without POS_API_SECRET, and refuse a wrong or missing token", async () => {
    // No request may reach Ivora from these checks.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { POST } = await import("@/app/api/pos/mark-paid/route");
    const { GET } = await import("@/app/api/pos/sessions/route");
    stub({ ...live, POS_API_SECRET: "" });
    expect((await POST(post("Bearer x", {}, "10.0.0.1"))).status).toBe(404);
    stub({ POS_API_SECRET: "pos_secret_1" });
    const wrong = await POST(post("Bearer nope", {}, "10.0.0.2"));
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).not.toContain("pos_secret_1");
    expect((await POST(post(null, {}, "10.0.0.3"))).status).toBe(401);
    // Right token, bad body: refused before any Ivora call.
    const bad = await POST(
      post(
        "Bearer pos_secret_1",
        { sale_id: "x", amount_minor: 1.5 },
        "10.0.0.4",
      ),
    );
    expect(bad.status).toBe(400);
    const list = (auth: string, query: string) =>
      GET(
        new Request(`https://charge.example.com/api/pos/sessions${query}`, {
          headers: { authorization: auth, "x-forwarded-for": "10.0.0.5" },
        }),
      );
    expect((await list("Bearer nope", "?status=due")).status).toBe(401);
    expect((await list("Bearer pos_secret_1", "?status=open")).status).toBe(
      400,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rate-limit mark-paid per client, before checking the token", async () => {
    const { POST } = await import("@/app/api/pos/mark-paid/route");
    stub({ ...live, POS_API_SECRET: "pos_secret_1" });
    const codes: number[] = [];
    for (let i = 0; i < 31; i++)
      codes.push((await POST(post("Bearer guess", {}, "10.0.9.9"))).status);
    expect(codes.slice(0, 30).every((c) => c === 401)).toBe(true);
    expect(codes[30]).toBe(429);
  });
});

describe("emailed receipts", () => {
  const view = {
    sale: "post-3fa9c01b77de",
    demo: true,
    terms: { mode: "postpay", prepaidCents: null, limitWh: null },
    charger: { code: "DEMO-3", label: "Charger 3", name: "Demo", connector: 1 },
    phase: "done",
    currency: "USD",
    energyWh: 36_000,
    powerW: 0,
    runningCents: 1940,
    startedAt: "2026-10-20T15:00:00Z",
    endedAt: "2026-10-20T15:30:00Z",
    stopping: false,
    stopProblem: null,
    limitReached: null,
    canStop: false,
    bill: null,
    amounts: {
      dueCents: 1940,
      prepaidCents: 0,
      coveredCents: 0,
      changeCents: 0,
      changeGiven: false,
      overrunCents: 0,
      collectedCents: 1940,
      outstandingCents: 0,
      prepaidRecorded: true,
      payments: [
        {
          step: "paid",
          method: "card",
          posReference: "1042",
          amountCents: 1940,
        },
      ],
      settledAt: null,
      status: "paid",
    },
    speed: 30,
    message: null,
    error: null,
  } satisfies SaleView;
  const email = receiptEmail(view, "driver@example.com", {
    siteName: "Demo <Forecourt>",
    timeZone: "UTC",
  });

  it("are never sent in demo mode: the demo shows the email instead", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const mailer: ReceiptMailer = { send: vi.fn(async () => ({ id: "m_1" })) };
    const result = await deliverReceipt(email, "key-1", {
      demo: true,
      mailer,
      sale: view.sale,
    });
    expect(result).toMatchObject({ sent: false, demo: true });
    expect(result.preview?.to).toBe("driver@example.com");
    expect(result.preview?.text).toContain(
      "Paid in store (card), POS ref 1042",
    );
    expect(mailer.send).not.toHaveBeenCalled();
    // Demo mode gets no provider at all, even with a key set.
    vi.stubEnv("RESEND_API_KEY", "re_test_only");
    vi.stubEnv("RECEIPT_EMAIL_FROM", "receipts@example.com");
    expect(receiptMailer(readSettings({ DEMO_MODE: "1" }))).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("send once per tap through the provider when one is set, without logging the address", async () => {
    const mailer: ReceiptMailer = { send: vi.fn(async () => ({ id: "m_1" })) };
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const result = await deliverReceipt(email, "key-1", {
      demo: false,
      mailer,
      sale: view.sale,
    });
    expect(result).toEqual({ sent: true, demo: false, preview: null });
    expect(mailer.send).toHaveBeenCalledWith(email, "key-1");
    expect(JSON.stringify(info.mock.calls)).not.toContain("driver@example.com");
  });

  it("escape the HTML and accept only a plausible single address", () => {
    expect(email.html).toContain("Demo &lt;Forecourt&gt;");
    expect(email.html).not.toContain("<Forecourt>");
    expect(email.subject).toBe(
      "Demo <Forecourt>: EV charging receipt, Charger 3",
    );
    expect(isEmailAddress("driver@example.com")).toBe(true);
    expect(isEmailAddress("a@b.com, c@d.com")).toBe(false);
    expect(isEmailAddress("no-at.example.com")).toBe(false);
    expect(isEmailAddress(`${"a".repeat(250)}@b.co`)).toBe(false);
  });
});
