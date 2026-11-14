import { beforeEach, describe, expect, it, vi } from "vitest";

// The Stripe SDK, mocked at the module boundary: no network, no keys.
const list = vi.fn();
vi.mock("stripe", () => {
  class StripeError extends Error {
    code?: string;
  }
  class Stripe {
    static errors = { StripeError };
    checkout = { sessions: { list } };
  }
  return { default: Stripe };
});

const { StripeGateway, MAX_CHECKOUT_PAGES } =
  await import("@/lib/server/stripe");

const T0 = Date.parse("2026-10-19T12:00:00Z");

function session(id: string, piStatus: string | null) {
  return {
    id,
    status: "complete",
    url: null,
    metadata: { fc_code: "PUMP-3", fc_tenant: "1" },
    payment_intent:
      piStatus === null
        ? null
        : {
            id: `pi_${id}`,
            status: piStatus,
            currency: "usd",
            amount: 5000,
            amount_received: 0,
            capture_method: "manual",
            application_fee_amount: null,
            metadata: { fc_tenant: "1" },
            created: T0 / 1000,
          },
  };
}

beforeEach(() => {
  list.mockReset();
});

describe("StripeGateway.listAuthorizedCheckouts", () => {
  it("lists completed checkouts since the window, keeping only authorized holds", async () => {
    list.mockResolvedValueOnce({
      data: [
        session("cs_a", "requires_capture"),
        session("cs_b", "succeeded"),
        session("cs_c", "canceled"),
        session("cs_d", null),
      ],
      has_more: false,
    });
    const gateway = new StripeGateway("sk_test_x", "acct_site");
    const result = await gateway.listAuthorizedCheckouts(T0 + 999);
    expect(result.truncated).toBe(false);
    expect(result.checkouts.map((c) => c.id)).toEqual(["cs_a"]);
    expect(result.checkouts[0].hold).toMatchObject({
      id: "pi_cs_a",
      status: "requires_capture",
      amountCents: 5000,
      manualCapture: true,
      createdAt: T0,
    });
    expect(result.checkouts[0].metadata.fc_tenant).toBe("1");
    expect(list).toHaveBeenCalledTimes(1);
    const [params, options] = list.mock.calls[0];
    expect(params).toEqual({
      created: { gte: Math.floor((T0 + 999) / 1000) },
      status: "complete",
      limit: 100,
      expand: ["data.payment_intent"],
    });
    // Direct charges: the listing reads the site operator's connected account.
    expect(options).toEqual({ stripeAccount: "acct_site" });
  });

  it("pages with starting_after until Stripe says there is no more", async () => {
    list
      .mockResolvedValueOnce({
        data: [
          session("cs_1", "requires_capture"),
          session("cs_2", "succeeded"),
        ],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [session("cs_3", "requires_capture")],
        has_more: false,
      });
    const gateway = new StripeGateway("sk_test_x", "");
    const result = await gateway.listAuthorizedCheckouts(T0);
    expect(result).toMatchObject({ truncated: false });
    expect(result.checkouts.map((c) => c.id)).toEqual(["cs_1", "cs_3"]);
    expect(list.mock.calls[1][0]).toMatchObject({ starting_after: "cs_2" });
    expect(list.mock.calls[0][1]).toEqual({});
  });

  it("stops at the page ceiling and says the list was truncated", async () => {
    list.mockImplementation(async () => ({
      data: [session(`cs_${list.mock.calls.length}`, "requires_capture")],
      has_more: true,
    }));
    const gateway = new StripeGateway("sk_test_x", "");
    const result = await gateway.listAuthorizedCheckouts(T0);
    expect(result.truncated).toBe(true);
    expect(list).toHaveBeenCalledTimes(MAX_CHECKOUT_PAGES);
    expect(result.checkouts).toHaveLength(MAX_CHECKOUT_PAGES);
  });
});
