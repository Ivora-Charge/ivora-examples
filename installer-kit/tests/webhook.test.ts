import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EventDeduper,
  signWebhook,
  verifyWebhookSignature,
  webhookDigest,
} from "@/lib/webhook";
import { resetStoreForTests } from "@/lib/server/store";
import {
  addCharger,
  createSite,
  setBackendForTests,
} from "@/lib/server/service";
import { demoBackend } from "@/lib/server/demo-backend";
import { POST } from "@/app/api/webhooks/ivora/route";
import { db } from "@/lib/server/store";

const SECRET = "whsec_test_fixed";
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);

describe("Ivora-Signature verification", () => {
  const body = '{"id":"evt_1","type":"station.booted"}';

  it("accepts t=<unix>,v1=<hmac of t.body>", () => {
    const header = signWebhook(SECRET, body, NOW);
    expect(header).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
    expect(verifyWebhookSignature(SECRET, header, body, NOW)).toBe("ok");
  });

  it("signs the timestamp together with the raw body", () => {
    const t = String(NOW / 1000);
    expect(webhookDigest(SECRET, t, body)).toBe(
      createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex"),
    );
    // A plain HMAC of the body alone (no timestamp) must not verify.
    const bodyOnly = createHmac("sha256", SECRET).update(body).digest("hex");
    expect(
      verifyWebhookSignature(SECRET, `t=${t},v1=${bodyOnly}`, body, NOW),
    ).toBe("invalid");
  });

  it("rejects a tampered body, wrong secret, or missing header", () => {
    const header = signWebhook(SECRET, body, NOW);
    expect(verifyWebhookSignature(SECRET, header, body + " ", NOW)).toBe(
      "invalid",
    );
    expect(verifyWebhookSignature("other", header, body, NOW)).toBe("invalid");
    expect(verifyWebhookSignature(SECRET, null, body, NOW)).toBe("invalid");
    expect(verifyWebhookSignature("", header, body, NOW)).toBe("invalid");
    expect(verifyWebhookSignature(SECRET, "v1=abc", body, NOW)).toBe("invalid");
    expect(verifyWebhookSignature(SECRET, "t=1,v1=zz", body, NOW)).toBe(
      "invalid",
    );
  });

  it("rejects timestamps more than five minutes away", () => {
    const old = signWebhook(SECRET, body, NOW - 6 * 60_000);
    const future = signWebhook(SECRET, body, NOW + 6 * 60_000);
    const edge = signWebhook(SECRET, body, NOW - 4 * 60_000);
    expect(verifyWebhookSignature(SECRET, old, body, NOW)).toBe("stale");
    expect(verifyWebhookSignature(SECRET, future, body, NOW)).toBe("stale");
    expect(verifyWebhookSignature(SECRET, edge, body, NOW)).toBe("ok");
  });

  it("accepts any matching v1 during secret rotation", () => {
    const header = signWebhook(SECRET, body, NOW);
    const t = header.split(",")[0];
    const other = signWebhook("old-secret", body, NOW).split(",")[1];
    expect(
      verifyWebhookSignature(
        SECRET,
        `${t},${other},${header.split(",")[1]}`,
        body,
        NOW,
      ),
    ).toBe("ok");
  });
});

describe("event deduplication", () => {
  it("accepts each ID once and forgets the oldest past capacity", () => {
    const d = new EventDeduper(2);
    expect(d.add("a")).toBe(true);
    expect(d.add("a")).toBe(false);
    d.add("b");
    d.add("c");
    expect(d.add("a")).toBe(true);
  });
});

describe("webhook route", () => {
  beforeEach(() => {
    resetStoreForTests();
    setBackendForTests(demoBackend);
    process.env.IVORA_WEBHOOK_SECRET = SECRET;
    process.env.IVORA_TENANT_ID = "42";
  });
  afterEach(() => {
    setBackendForTests(null);
    delete process.env.IVORA_WEBHOOK_SECRET;
    delete process.env.IVORA_TENANT_ID;
  });

  const deliver = (payload: object, headers: Record<string, string> = {}) => {
    const raw = JSON.stringify(payload);
    return POST(
      new Request("http://localhost/api/webhooks/ivora", {
        method: "POST",
        body: raw,
        headers: { "Ivora-Signature": signWebhook(SECRET, raw), ...headers },
      }),
    );
  };

  it("applies station.booted once and acknowledges redeliveries", async () => {
    const site = await createSite({ name: "S", address: "1 Example Way" });
    const { charger } = await addCharger({ siteId: site.id, name: "ik-test1" });
    const event = {
      id: "evt_123",
      type: "station.booted",
      tenant_id: 42,
      station_id: charger.stationId,
      data: { vendor: "Acme", model: "AC-7", firmware_version: "2.4.1" },
    };
    const first = await deliver(event);
    expect(first.status).toBe(200);
    expect(db().chargers.get(charger.id)?.state).toBe("booted");
    expect(db().chargers.get(charger.id)?.boot?.firmware).toBe("2.4.1");

    db().chargers.get(charger.id)!.state = "waiting";
    const again = await deliver(event);
    expect(await again.json()).toMatchObject({ duplicate: true });
    expect(db().chargers.get(charger.id)?.state).toBe("waiting");
  });

  it("deduplicates by the signed body id, ignoring the unsigned header", async () => {
    const event = { id: "evt_a", type: "webhook.test", tenant_id: 42 };
    const first = await deliver(event, { "Ivora-Event-Id": "h1" });
    expect(await first.json()).toEqual({ received: true });
    const replay = await deliver(event, { "Ivora-Event-Id": "h2" });
    expect(await replay.json()).toMatchObject({ duplicate: true });
    // A different body id is new even when the header repeats.
    const other = await deliver(
      { ...event, id: "evt_b" },
      { "Ivora-Event-Id": "h1" },
    );
    expect(await other.json()).toEqual({ received: true });
  });

  it("rejects bad signatures, other tenants and a missing secret", async () => {
    const raw = JSON.stringify({
      id: "x",
      type: "station.connected",
      tenant_id: 42,
    });
    const bad = await POST(
      new Request("http://localhost/api/webhooks/ivora", {
        method: "POST",
        body: raw,
        headers: { "Ivora-Signature": signWebhook("wrong", raw) },
      }),
    );
    expect(bad.status).toBe(401);
    const unsigned = await POST(
      new Request("http://localhost/api/webhooks/ivora", {
        method: "POST",
        body: raw,
      }),
    );
    expect(unsigned.status).toBe(401);
    const tenant = await deliver({
      id: "y",
      type: "station.connected",
      tenant_id: 7,
    });
    expect(tenant.status).toBe(400);
    delete process.env.IVORA_WEBHOOK_SECRET;
    expect((await deliver({ id: "z", type: "x", tenant_id: 42 })).status).toBe(
      503,
    );
  });
});
