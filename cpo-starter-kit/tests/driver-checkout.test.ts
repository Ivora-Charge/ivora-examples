import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/(driver)/c/[code]/actions", () => ({
  freeAction: vi.fn(),
  payAction: vi.fn(),
  startAction: vi.fn(),
  stopAction: vi.fn(),
}));

import { PayForm } from "@/app/(driver)/c/[code]/forms";

/**
 * The Driver checkout restyle is presentation only: the pay form still submits exactly
 * the two fields the server action reads, and nothing about the amount. The Ivora calls
 * themselves (bill, payment, keys, hold) are pinned in checkout.test.ts
 * ("creates a bill and a driver-return payment ...").
 */
describe("driver pay form", () => {
  const markup = renderToStaticMarkup(
    h(PayForm, {
      code: "ABCD2345",
      requestId: "11111111-2222-4333-8444-555555555555",
      hold: "$25.00",
      closed: false,
      demo: false,
    }),
  );

  it("posts only the sticker code and the request id: no amount, hold or price field", () => {
    const fields = [...markup.matchAll(/<input[^>]*name="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(fields).toEqual(["code", "requestId"]);
    expect(markup).toContain('value="ABCD2345"');
    expect(markup).toContain('value="11111111-2222-4333-8444-555555555555"');
  });

  it("keeps the button label and shows the hold", () => {
    expect(markup).toContain("Pay and charge ($25.00 hold)");
  });

  it("is off when the connector is closed", () => {
    const closed = renderToStaticMarkup(
      h(PayForm, {
        code: "ABCD2345",
        requestId: "r",
        hold: null,
        closed: true,
        demo: false,
      }),
    );
    expect(closed).toContain("disabled");
    expect(closed).toContain("Not available right now");
  });
});
