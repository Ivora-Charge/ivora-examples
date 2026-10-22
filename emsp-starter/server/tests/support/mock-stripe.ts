/**
 * Just enough of Stripe's REST API, in process, for the payment tests: customers,
 * saved cards, SetupIntents and ephemeral keys, manual-capture PaymentIntents (hold,
 * capture, cancel, incremental authorization) and refunds. Mount it on the in-process
 * network as `api.stripe.com`: the server's own Stripe client talks to it over HTTP,
 * through `outboundFetch`, so nothing leaves the process.
 *
 * Like Stripe, a repeated Idempotency-Key replays the first answer, and the same key
 * with other parameters is refused (400 idempotency_error).
 *
 * Card behaviours, by payment method ID (attach one with `attachCard`):
 * - `pm_card_visa`: authorises; incremental authorization available.
 * - `pm_card_noincrement`: authorises; incremental authorization unavailable.
 * - `pm_card_declined`: 402 card_declined.
 * - `pm_card_insufficient`: 402 card_declined, decline_code insufficient_funds.
 * - `pm_card_sca`: 402 authentication_required (off-session 3-D Secure).
 */
type Json = Record<string, unknown>;

export type StripeCall = {
  method: string;
  path: string;
  key: string | null;
  version: string | null;
  params: URLSearchParams;
};

type Intent = {
  id: string;
  object: "payment_intent";
  status: string;
  amount: number;
  amount_capturable: number;
  amount_received: number;
  currency: string;
  customer: string;
  payment_method: string;
  metadata: Record<string, string>;
  incremental: boolean;
  refunded: number;
};

export function createMockStripe({ now = () => Date.now() } = {}) {
  let seq = 0;
  const id = (prefix: string) =>
    `${prefix}_${(++seq).toString(36)}${"x".repeat(4)}`;
  const state = {
    customers: new Map<string, Json>(),
    cards: new Map<string, { customer: string | null; behaviour: string }>(),
    intents: new Map<string, Intent>(),
    refunds: new Map<string, Json>(),
    idempotency: new Map<
      string,
      { fingerprint: string; status: number; body: Json }
    >(),
    calls: [] as StripeCall[],
    /** Days a hold lasts (capture_before). */
    holdDays: 7,
    /** Refuse every increment_authorization. */
    declineIncrements: false,
    /** Failures to inject, first match first: drops the request or answers 5xx. */
    failures: [] as {
      path: RegExp;
      kind: "network" | "500";
      times: number;
      after?: boolean;
    }[],
  };

  const metadataOf = (p: URLSearchParams) => {
    const out: Record<string, string> = {};
    for (const [k, v] of p) {
      const m = /^metadata\[(.+)\]$/.exec(k);
      if (m) out[m[1]] = v;
    }
    return out;
  };

  const charge = (pi: Intent) => ({
    id: `ch_${pi.id.slice(3)}`,
    object: "charge",
    payment_intent: pi.id,
    amount: pi.amount,
    amount_captured: pi.amount_received,
    amount_refunded: pi.refunded,
    currency: pi.currency,
    payment_method_details: {
      card: {
        brand: "visa",
        last4: "4242",
        capture_before: Math.floor(now() / 1000) + state.holdDays * 86_400,
        incremental_authorization: {
          status: pi.incremental ? "available" : "unavailable",
        },
      },
    },
  });

  const view = (pi: Intent): Json => {
    const { incremental: _i, refunded: _r, ...rest } = pi;
    return { ...rest, latest_charge: charge(pi) };
  };

  const error = (
    status: number,
    type: string,
    code?: string,
    extra: Json = {},
  ) => ({
    status,
    body: { error: { type, code, message: "Mock Stripe error", ...extra } },
  });

  function route(
    method: string,
    path: string,
    p: URLSearchParams,
    version: string | null,
  ): { status: number; body: Json } {
    let m: RegExpExecArray | null;
    if (method === "POST" && path === "/v1/customers") {
      const c = {
        id: id("cus"),
        object: "customer",
        email: p.get("email"),
        metadata: metadataOf(p),
      };
      state.customers.set(c.id, c);
      return { status: 200, body: c };
    }
    if (method === "POST" && (m = /^\/v1\/customers\/([^/]+)$/.exec(path))) {
      const c = state.customers.get(m[1]);
      if (!c) return error(404, "invalid_request_error", "resource_missing");
      return { status: 200, body: c };
    }
    if (method === "POST" && path === "/v1/setup_intents") {
      const sid = id("seti");
      return {
        status: 200,
        body: {
          id: sid,
          object: "setup_intent",
          client_secret: `${sid}_secret_mock`,
          customer: p.get("customer"),
          status: "requires_payment_method",
          payment_method: null,
        },
      };
    }
    if (method === "POST" && path === "/v1/ephemeral_keys") {
      if (!version)
        return error(400, "invalid_request_error", "missing_version");
      return {
        status: 200,
        body: {
          id: id("ephkey"),
          object: "ephemeral_key",
          secret: `ek_test_${seq}`,
        },
      };
    }
    if (
      method === "GET" &&
      (m = /^\/v1\/customers\/([^/]+)\/payment_methods$/.exec(path))
    ) {
      const data = [...state.cards]
        .filter(([, c]) => c.customer === m![1])
        .map(([pm, c]) => ({
          id: pm,
          object: "payment_method",
          type: "card",
          customer: c.customer,
          card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
        }));
      return { status: 200, body: { object: "list", data } };
    }
    if ((m = /^\/v1\/payment_methods\/([^/]+)(\/detach)?$/.exec(path))) {
      const card = state.cards.get(m[1]);
      if (!card) return error(404, "invalid_request_error", "resource_missing");
      if (m[2] && method === "POST") card.customer = null;
      return {
        status: 200,
        body: {
          id: m[1],
          object: "payment_method",
          type: "card",
          customer: card.customer,
          card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
        },
      };
    }
    if (method === "POST" && path === "/v1/payment_intents") {
      const pm = p.get("payment_method") ?? "";
      const card = state.cards.get(pm);
      if (!card || card.customer !== p.get("customer"))
        return error(400, "invalid_request_error", "resource_missing");
      if (
        p.get("capture_method") !== "manual" ||
        p.get("confirm") !== "true" ||
        p.get("off_session") !== "true"
      )
        return error(400, "invalid_request_error", "parameter_invalid");
      const pi: Intent = {
        id: id("pi"),
        object: "payment_intent",
        status: "requires_capture",
        amount: Number(p.get("amount")),
        amount_capturable: Number(p.get("amount")),
        amount_received: 0,
        currency: p.get("currency") ?? "",
        customer: p.get("customer") ?? "",
        payment_method: pm,
        metadata: metadataOf(p),
        incremental:
          card.behaviour === "visa" &&
          p.get(
            "payment_method_options[card][request_incremental_authorization]",
          ) === "if_available",
        refunded: 0,
      };
      if (["declined", "insufficient", "sca"].includes(card.behaviour)) {
        pi.status =
          card.behaviour === "sca"
            ? "requires_action"
            : "requires_payment_method";
        pi.amount_capturable = 0;
        state.intents.set(pi.id, pi);
        return error(
          402,
          "card_error",
          card.behaviour === "sca"
            ? "authentication_required"
            : "card_declined",
          {
            decline_code:
              card.behaviour === "insufficient"
                ? "insufficient_funds"
                : undefined,
            payment_intent: view(pi),
          },
        );
      }
      state.intents.set(pi.id, pi);
      return { status: 200, body: view(pi) };
    }
    if (
      (m =
        /^\/v1\/payment_intents\/([^/]+)(?:\/(capture|cancel|increment_authorization))?$/.exec(
          path,
        ))
    ) {
      const pi = state.intents.get(m[1]);
      if (!pi) return error(404, "invalid_request_error", "resource_missing");
      const action = m[2];
      if (method === "GET") return { status: 200, body: view(pi) };
      if (action === "capture") {
        if (pi.status === "canceled")
          return error(
            400,
            "invalid_request_error",
            "charge_expired_for_capture",
          );
        if (pi.status !== "requires_capture")
          return error(
            400,
            "invalid_request_error",
            "payment_intent_unexpected_state",
          );
        const amount = Number(
          p.get("amount_to_capture") ?? pi.amount_capturable,
        );
        if (amount > pi.amount_capturable)
          return error(400, "invalid_request_error", "amount_too_large");
        Object.assign(pi, {
          status: "succeeded",
          amount_received: amount,
          amount_capturable: 0,
        });
        return { status: 200, body: view(pi) };
      }
      if (action === "cancel") {
        if (pi.status === "succeeded")
          return error(
            400,
            "invalid_request_error",
            "payment_intent_unexpected_state",
          );
        Object.assign(pi, { status: "canceled", amount_capturable: 0 });
        return { status: 200, body: view(pi) };
      }
      if (action === "increment_authorization") {
        if (pi.status !== "requires_capture" || !pi.incremental)
          return error(
            400,
            "invalid_request_error",
            "payment_intent_unexpected_state",
          );
        if (state.declineIncrements)
          return error(402, "card_error", "card_declined");
        const amount = Number(p.get("amount"));
        Object.assign(pi, { amount, amount_capturable: amount });
        return { status: 200, body: view(pi) };
      }
    }
    if (method === "POST" && path === "/v1/refunds") {
      const pi = state.intents.get(p.get("payment_intent") ?? "");
      if (!pi || pi.status !== "succeeded")
        return error(400, "invalid_request_error", "charge_not_refundable");
      const amount = Number(p.get("amount"));
      if (pi.refunded + amount > pi.amount_received)
        return error(400, "invalid_request_error", "amount_too_large");
      pi.refunded += amount;
      const r = {
        id: id("re"),
        object: "refund",
        amount,
        status: "succeeded",
        payment_intent: pi.id,
      };
      state.refunds.set(r.id, r);
      return { status: 200, body: r };
    }
    return error(404, "invalid_request_error", "unknown_route");
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const text = method === "POST" ? await request.text() : "";
    const params =
      method === "POST" ? new URLSearchParams(text) : url.searchParams;
    const key = request.headers.get("idempotency-key");
    const version = request.headers.get("stripe-version");
    state.calls.push({ method, path: url.pathname, key, version, params });
    if (!/^Bearer sk_test_/.test(request.headers.get("authorization") ?? ""))
      return Response.json(error(401, "invalid_request_error").body, {
        status: 401,
      });
    const failure = state.failures.find(
      (f) => f.times > 0 && f.path.test(url.pathname),
    );
    if (failure && !failure.after) {
      failure.times--;
      if (failure.kind === "network") throw new TypeError("fetch failed");
      return Response.json({ error: { type: "api_error" } }, { status: 500 });
    }
    const fingerprint = `${method} ${url.pathname} ${text}`;
    let answer: { status: number; body: Json };
    const held = key ? state.idempotency.get(key) : undefined;
    if (held)
      answer =
        held.fingerprint === fingerprint
          ? held
          : error(400, "idempotency_error", "idempotency_key_in_use");
    else {
      answer = route(method, url.pathname, params, version);
      if (key && method === "POST" && answer.status !== 500)
        state.idempotency.set(key, { fingerprint, ...answer });
    }
    // A failure "after" the work: Stripe did it, but the answer is lost.
    if (failure?.after) {
      failure.times--;
      throw new TypeError("fetch failed");
    }
    return Response.json(answer.body, { status: answer.status });
  }

  return {
    state,
    handle,
    /** A Customer, as if made earlier. */
    customer(email = "driver@example.com") {
      const c = { id: id("cus"), object: "customer", email };
      state.customers.set(c.id, c);
      return c.id;
    },
    /** Saves a card on a customer: `pm_card_<behaviour>`, or a new ID per call. */
    attachCard(customer: string, behaviour = "visa", pm?: string) {
      const pmId = pm ?? `pm_card_${behaviour}${seq++}`;
      state.cards.set(pmId, { customer, behaviour });
      return pmId;
    },
    /** The card network drops a hold, as after 7 days. */
    expire(paymentIntentId: string) {
      const pi = state.intents.get(paymentIntentId)!;
      Object.assign(pi, { status: "canceled", amount_capturable: 0 });
    },
    intent: (pid: string) => state.intents.get(pid),
    callsTo: (path: RegExp, method = "POST") =>
      state.calls.filter((c) => c.method === method && path.test(c.path)),
  };
}

export type MockStripe = ReturnType<typeof createMockStripe>;
