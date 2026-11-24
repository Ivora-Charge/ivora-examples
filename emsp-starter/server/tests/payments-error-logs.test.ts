import { afterEach, describe, expect, it, vi } from "vitest";
import { emitPaymentEvent, onPaymentEvent } from "@/lib/payments/events";
import type { PaymentDeps } from "@/lib/payments/registry";
import { audit, sweepPayments } from "@/lib/payments/settle";
import type { Payment } from "@/lib/payments/store";
import { handleEvent } from "@/lib/payments/webhook";
import { supabaseRest } from "@/lib/server/supabase-rest";

// A payment-path error may carry a key, an email or a URL query in its message. The
// payment logs keep the safe text only: the table and HTTP status of a database
// refusal, the name of any other error.
const KEY = "sb_secret_exampleKEYexample";
const EMAIL = "driver@example.test";
const QUERY = `select=*&email=eq.${EMAIL}`;
const LEAKS = [KEY, EMAIL, "select=", "email=eq", "secret row"];

/** A real DatabaseRequestError from the Supabase client, after a refused request. */
async function databaseError(status: number): Promise<unknown> {
  const rest = supabaseRest("https://x.supabase.test", KEY, async () =>
    Response.json({ message: `secret row ${EMAIL} ${KEY}` }, { status }),
  );
  return rest("GET", `emsp_payments?${QUERY}`).catch((e: unknown) => e);
}

/** Any other error, its message holding a URL with a query and a key. */
const otherError = () =>
  new TypeError(`fetch https://x.supabase.test/rest/v1/emsp_payments?${QUERY}`);

function captureLogs() {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return () => spy.mock.calls.map((c) => c.join(" ")).join("\n");
}

function expectSafe(line: string) {
  for (const leak of LEAKS) expect(line).not.toContain(leak);
}

const payment = {
  id: "pay-1",
  commandId: "cmd-1",
  status: "held",
  currency: "USD",
  review: null,
} as unknown as Payment;

afterEach(() => vi.restoreAllMocks());

describe("payment error logs", () => {
  it("a failed payment listener logs the error name only", async () => {
    const logs = captureLogs();
    const off = onPaymentEvent(() => {
      throw otherError();
    });
    try {
      await emitPaymentEvent({
        type: "payment.released",
      } as unknown as Parameters<typeof emitPaymentEvent>[0]);
    } finally {
      off();
    }
    expect(logs()).toContain("listener failed: TypeError");
    expectSafe(logs());
  });

  it("a failed audit logs the table and HTTP status, no key or query", async () => {
    const err = await databaseError(401);
    const logs = captureLogs();
    const deps = {
      peers: { audit: async () => Promise.reject(err) },
    } as unknown as PaymentDeps;
    await expect(audit(deps, "payment.held", payment)).resolves.toBeUndefined();
    expect(logs()).toContain("Audit of payment pay-1 failed:");
    expect(logs()).toContain("DatabaseRequestError");
    expect(logs()).toContain("emsp_payments");
    expect(logs()).toContain("HTTP 401");
    expectSafe(logs());
  });

  it("the sweep logs safe text and still returns its counts", async () => {
    const dbErr = await databaseError(404);
    const logs = captureLogs();
    const deps = {
      payments: {
        listHeld: async () => [payment],
        markSwept: async () => Promise.reject(dbErr),
      },
      sessions: {
        findCdrsByCommand: async () => Promise.reject(otherError()),
      },
      now: () => new Date("2026-10-21T10:00:00Z"),
    } as unknown as PaymentDeps;
    expect(await sweepPayments(deps)).toEqual({
      settled: 0,
      released: 0,
      expired: 0,
    });
    expect(logs()).toContain("Payment sweep of pay-1 failed: TypeError");
    expect(logs()).toContain(
      "Recording the payment sweep failed: DatabaseRequestError",
    );
    expect(logs()).toContain("emsp_payments");
    expect(logs()).toContain("HTTP 404");
    expectSafe(logs());
  });

  it("a failed Stripe event logs safe text and still throws the same error", async () => {
    const err = await databaseError(500);
    const logs = captureLogs();
    const deps = {
      payments: { hasEvent: async () => false },
      accounts: { getDriverByCustomer: async () => Promise.reject(err) },
    } as unknown as PaymentDeps;
    const thrown = await handleEvent(
      {
        id: "evt_1",
        type: "setup_intent.succeeded",
        data: {
          object: {
            object: "setup_intent",
            customer: "cus_1",
            payment_method: "pm_1",
          },
        },
      } as unknown as Parameters<typeof handleEvent>[0],
      deps,
    ).catch((e: unknown) => e);
    expect(thrown).toBe(err);
    expect(logs()).toContain(
      "Stripe event evt_1 (setup_intent.succeeded) failed: DatabaseRequestError",
    );
    expect(logs()).toContain("HTTP 500");
    expectSafe(logs());
  });
});
