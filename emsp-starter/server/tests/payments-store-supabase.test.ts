import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { SupabaseAccountStore } from "@/lib/accounts/store-supabase";
import { SupabasePaymentStore } from "@/lib/payments/store-supabase";
import { SupabaseSessionStore } from "@/lib/sessions/store-supabase";
import { asRole, migratedDatabase } from "./support/pglite";
import { pgliteRest } from "./support/pglite-rest";

const PEER = "8b0f0b5e-3c47-4c1e-9d55-4f1f0f8d2b11";
const DRIVER = "6b1c4c1e-8c47-4f5e-9d55-0f1f0f8d2b11";
const NOW = "2026-10-22T10:00:00.000Z";
let db: PGlite;
let accounts: SupabaseAccountStore;
let payments: SupabasePaymentStore;
let sessions: SupabaseSessionStore;

beforeAll(async () => {
  db = await migratedDatabase();
  const rest = pgliteRest(db);
  accounts = new SupabaseAccountStore(
    "https://db.example.test",
    "test-service-role-key",
    rest,
  );
  payments = new SupabasePaymentStore(
    "https://db.example.test",
    "test-service-role-key",
    rest,
  );
  sessions = new SupabaseSessionStore(
    "https://db.example.test",
    "test-service-role-key",
    rest,
  );
}, 60_000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec(`
    delete from public.emsp_payment_refunds; delete from public.emsp_payments;
    delete from public.emsp_stripe_events; delete from public.emsp_drivers;
    delete from public.emsp_admins;
    delete from public.emsp_sessions; delete from public.emsp_commands;
    delete from public.emsp_ocpi_peers;`);
  await db.query(
    "insert into public.emsp_ocpi_peers (id, label, direction) values ($1, 'CPO', 'outbound')",
    [PEER],
  );
});

/** A START_SESSION command row, as the commands module makes it. */
async function command(): Promise<string> {
  const {
    rows: [row],
  } = await db.query<{ id: string }>(
    `insert into public.emsp_commands (type, driver_ref, request_id, peer_id, to_country_code,
       to_party_id, location_id, authorization_reference, deadline_at)
     values ('START_SESSION', $1, $2, $3, 'ZZ', 'MCK', 'LOC1', $4, now()) returning id`,
    [DRIVER, `req-${crypto.randomUUID()}`, PEER, crypto.randomUUID()],
  );
  return row.id;
}

const newPayment = async (holdAmount = 2500) =>
  (await payments.insert(
    {
      commandId: await command(),
      driverRef: DRIVER,
      currency: "EUR",
      holdAmount,
      paymentMethodId: "pm_card_visa",
    },
    NOW,
  ))!;

describe("driver accounts and admin roles in Supabase", () => {
  it("makes an account once, sets the Customer once, and reads admin roles", async () => {
    const a = await accounts.ensureDriver(DRIVER, "d@example.com", NOW);
    expect(a).toMatchObject({
      id: DRIVER,
      email: "d@example.com",
      status: "active",
      stripeCustomerId: null,
    });
    expect(
      (await accounts.ensureDriver(DRIVER, "new@example.com", NOW)).email,
    ).toBe("new@example.com");
    expect(await accounts.setCustomer(DRIVER, "cus_A1", NOW)).toMatchObject({
      stripeCustomerId: "cus_A1",
    });
    expect(await accounts.setCustomer(DRIVER, "cus_B2", NOW)).toBeNull();
    expect((await accounts.getDriverByCustomer("cus_A1"))!.id).toBe(DRIVER);
    expect(
      await accounts.updateDriver(
        DRIVER,
        { defaultPaymentMethodId: "pm_1Abc", status: "restricted" },
        NOW,
      ),
    ).toMatchObject({
      defaultPaymentMethodId: "pm_1Abc",
      status: "restricted",
    });
    // IDs only: a card number is not a payment method ID.
    await expect(
      accounts.updateDriver(
        DRIVER,
        { defaultPaymentMethodId: "4242424242424242" },
        NOW,
      ),
    ).rejects.toThrow();

    expect(await accounts.adminRole(DRIVER)).toBeNull();
    await db.query(
      "insert into public.emsp_admins (user_id, role) values ($1, 'viewer')",
      [DRIVER],
    );
    expect(await accounts.adminRole(DRIVER)).toBe("viewer");
    // The server reads the admin table and never writes it.
    await expect(
      asRole(db, "service_role", () =>
        db.query("update public.emsp_admins set role = 'admin'"),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("keeps every new table away from anon and authenticated", async () => {
    for (const role of ["anon", "authenticated"] as const)
      for (const table of [
        "emsp_drivers",
        "emsp_admins",
        "emsp_payments",
        "emsp_payment_refunds",
        "emsp_stripe_events",
      ])
        await expect(
          asRole(db, role, () => db.query(`select * from public.${table}`)),
        ).rejects.toThrow(/permission denied/);
    await expect(
      asRole(db, "service_role", () =>
        db.query("delete from public.emsp_payments"),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("payments in Supabase", () => {
  it("has one payment per command, with compare-and-swap changes", async () => {
    const p = await newPayment();
    expect(p).toMatchObject({
      status: "pending",
      holdAmount: 2500,
      authorizedAmount: 0,
      increments: 0,
    });
    expect(
      await payments.insert(
        {
          commandId: p.commandId,
          driverRef: DRIVER,
          currency: "EUR",
          holdAmount: 1,
          paymentMethodId: null,
        },
        NOW,
      ),
    ).toBeNull();
    expect((await payments.getByCommand(p.commandId))!.id).toBe(p.id);

    const held = await payments.transition(
      p.id,
      ["pending"],
      {
        status: "held",
        authorizedAmount: 2500,
        paymentIntentId: "pi_1Abc",
        holdExpiresAt: NOW,
      },
      NOW,
    );
    expect(held).toMatchObject({
      status: "held",
      paymentIntentId: "pi_1Abc",
      holdExpiresAt: NOW,
    });
    expect(
      await payments.transition(p.id, ["pending"], { status: "failed" }, NOW),
    ).toBeNull();
    expect((await payments.getByIntent("pi_1Abc"))!.id).toBe(p.id);

    // One raise per increment number, whoever asks.
    expect(
      await payments.transition(
        p.id,
        ["held"],
        { increments: 1, authorizedAmount: 5000 },
        NOW,
        { ifIncrements: 0 },
      ),
    ).not.toBeNull();
    expect(
      await payments.transition(
        p.id,
        ["held"],
        { increments: 1, authorizedAmount: 5000 },
        NOW,
        { ifIncrements: 0 },
      ),
    ).toBeNull();

    expect(await payments.listHeld(10)).toHaveLength(1);
    await payments.transition(
      p.id,
      ["held"],
      { review: "cdr_above_hold", shortfallAmount: 300 },
      NOW,
    );
    expect((await payments.listReview(10)).map((x) => x.id)).toEqual([p.id]);
    await payments.transition(p.id, ["held"], { reviewedAt: NOW }, NOW);
    expect(await payments.listReview(10)).toEqual([]);
    expect((await payments.listByDriver(DRIVER, 10)).map((x) => x.id)).toEqual([
      p.id,
    ]);

    expect(await payments.claimReceipt(p.id, NOW)).toBe(true);
    expect(await payments.claimReceipt(p.id, NOW)).toBe(false);
  });

  it("never captures more than was authorised", async () => {
    const p = await newPayment();
    await payments.transition(
      p.id,
      ["pending"],
      { status: "held", authorizedAmount: 2500 },
      NOW,
    );
    await expect(
      payments.transition(
        p.id,
        ["held"],
        { status: "captured", capturedAmount: 2501 },
        NOW,
      ),
    ).rejects.toThrow();
    expect(
      await payments.transition(
        p.id,
        ["held"],
        { status: "captured", capturedAmount: 2500 },
        NOW,
      ),
    ).toMatchObject({ capturedAmount: 2500 });
  });

  it("reserves refunds under a lock: never more than captured, never twice per request", async () => {
    const p = await newPayment();
    await payments.transition(
      p.id,
      ["pending"],
      { status: "held", authorizedAmount: 2500 },
      NOW,
    );
    const reserve = (requestId: string, amount: number) =>
      payments.reserveRefund({
        paymentId: p.id,
        requestId,
        amount,
        reason: "",
        actor: "admin",
      });
    expect((await reserve("refund-0001", 100)).outcome).toBe("exceeds"); // not captured yet
    await payments.transition(
      p.id,
      ["held"],
      { status: "captured", capturedAmount: 1000 },
      NOW,
    );

    // Two at once for 600 each: only one fits in 1000.
    const both = await Promise.all([
      reserve("refund-0002", 600),
      reserve("refund-0003", 600),
    ]);
    expect(both.map((r) => r.outcome).sort()).toEqual(["created", "exceeds"]);
    const made = both.find((r) => r.outcome === "created")!.refund!;
    expect(await reserve(made.requestId, 600)).toMatchObject({
      outcome: "replayed",
      refund: { id: made.id },
    });
    expect((await payments.get(p.id))!.refundedAmount).toBe(0);

    expect(
      await payments.settleRefund(made.id, "succeeded", "re_1Abc"),
    ).toMatchObject({ status: "succeeded", stripeRefundId: "re_1Abc" });
    expect((await payments.get(p.id))!.refundedAmount).toBe(600);
    // Settled once only.
    expect(await payments.settleRefund(made.id, "failed", null)).toMatchObject({
      status: "succeeded",
    });
    const failed = (await reserve("refund-0004", 400)).refund!;
    await payments.settleRefund(failed.id, "failed", null);
    // A failed refund gives its amount back.
    expect((await reserve("refund-0005", 400)).outcome).toBe("created");
    expect((await payments.listRefunds(p.id)).map((r) => r.status)).toEqual([
      "succeeded",
      "failed",
      "pending",
    ]);
    expect(
      (
        await payments.reserveRefund({
          paymentId: crypto.randomUUID(),
          requestId: "refund-0006",
          amount: 1,
          reason: "",
          actor: "a",
        })
      ).outcome,
    ).toBe("not_found");
  });

  it("records each Stripe event once", async () => {
    expect(await payments.hasEvent("evt_1Abc")).toBe(false);
    expect(
      await payments.recordEvent("evt_1Abc", "payment_intent.canceled"),
    ).toBe(true);
    expect(
      await payments.recordEvent("evt_1Abc", "payment_intent.canceled"),
    ).toBe(false);
    expect(await payments.hasEvent("evt_1Abc")).toBe(true);
  });
});

describe("sessions: the stop reason and a start's CDRs", () => {
  it("keeps the stop reason through the CPO's later writes", async () => {
    const commandId = await command();
    const session = {
      country_code: "ZZ",
      party_id: "MCK",
      id: "S1",
      start_date_time: NOW,
      kwh: 1,
      cdr_token: {
        country_code: "NL",
        party_id: "ABC",
        uid: "U1",
        type: "APP_USER" as const,
        contract_id: "NLABCC12345678",
      },
      auth_method: "COMMAND" as const,
      location_id: "LOC1",
      evse_uid: "E1",
      connector_id: "1",
      currency: "EUR",
      status: "ACTIVE" as const,
      last_updated: NOW,
    };
    const write = {
      session,
      fieldTimes: {},
      driverRef: DRIVER,
      commandId,
      completedAt: null,
    };
    const s = (await sessions.insertSession(PEER, write, NOW))!;
    await sessions.setStopReason(
      s.id,
      "Stopped because your card did not allow a higher payment hold.",
      NOW,
    );
    const held = (await sessions.getSessionById(s.id))!;
    expect(held.stopReason).toMatch(/higher payment hold/);
    const updated = await sessions.updateSession(
      s.id,
      held.revision,
      { ...write, session: { ...session, kwh: 2 } },
      NOW,
    );
    expect(updated!.stopReason).toMatch(/higher payment hold/);
    expect(await sessions.findCdrsByCommand(commandId)).toEqual([]);
  });
});
