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
import { PriceText } from "@/app/(driver)/c/[code]/price-text";
import DriverError from "@/app/(driver)/error";
import { splitPriceText } from "@/lib/price-headline";
import { generatedDriverText } from "@/lib/server/pricing/tariff";

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

describe("driver price text", () => {
  const full =
    "$0.35 per kWh; $0.45 per kWh Mon–Fri 16:00–21:00; $1.00 session fee; idle fee $0.40 per minute plugged in but not charging, after the first 10 idle minutes. Times are America/New_York local time.";

  it("makes only the headline rate big and keeps the rest, unchanged, at body size", () => {
    expect(splitPriceText(full)).toEqual({
      headline: "$0.35 per kWh",
      rest: "$0.45 per kWh Mon–Fri 16:00–21:00; $1.00 session fee; idle fee $0.40 per minute plugged in but not charging, after the first 10 idle minutes. Times are America/New_York local time.",
    });
    const html = renderToStaticMarkup(h(PriceText, { text: full }));
    expect(html).toMatch(
      /<p class="price-big" data-testid="price-headline">\$0\.35 per kWh<\/p>/,
    );
    expect(html).toContain('<p data-testid="price-detail">$0.45 per kWh');
    expect(html.match(/price-big/g)).toHaveLength(1);
    expect(html).not.toMatch(/price-big[^<]*idle/);
  });

  it("handles a flat rate, free charging and a long custom description", () => {
    expect(splitPriceText("$0.35 per kWh. Times are UTC local time.")).toEqual({
      headline: "$0.35 per kWh",
      rest: "Times are UTC local time.",
    });
    expect(splitPriceText("Free charging.")).toEqual({
      headline: "Free charging",
      rest: "",
    });
    const custom =
      "Charging costs thirty-five cents for every kilowatt-hour you use here";
    expect(splitPriceText(custom)).toEqual({ headline: null, rest: custom });
  });

  it("loses no words from the kit's generated text", () => {
    const generated = generatedDriverText({
      kind: "paid",
      currency: "USD",
      energyMinorPerKwh: 35,
      sessionFeeMinor: 100,
      idleMinorPerMinute: 40,
      idleGraceMinutes: 0,
      periods: [],
      timeZone: "UTC",
      driverText: null,
    } as Parameters<typeof generatedDriverText>[0]);
    const { headline, rest } = splitPriceText(generated);
    expect(headline).toBe("$0.35 per kWh");
    const words = (t: string) =>
      t
        .toLowerCase()
        .replace(/[;]|\.(\s|$)/g, " ")
        .split(/\s+/)
        .filter(Boolean);
    expect([...words(headline ?? ""), ...words(rest)]).toEqual(
      words(generated),
    );
  });
});

describe("driver error page", () => {
  const render = (digest?: string) =>
    renderToStaticMarkup(
      h(DriverError, {
        error: Object.assign(new Error("secret detail"), { digest }),
        reset: () => {},
      }),
    );

  it("never claims nothing was charged, since a paid session may be running", () => {
    const html = render("abc123");
    expect(html).not.toMatch(/nothing (was|has been) charged/i);
    expect(html).not.toMatch(/not (been )?charged/i);
    expect(html).toContain(
      "This error didn&#x27;t start, stop or charge anything. A payment you",
    );
    expect(html).toContain("already made is not affected.");
  });

  it("shows the reference but never the error message", () => {
    expect(render("abc123")).toContain("<code>abc123</code>");
    expect(render("abc123")).not.toContain("secret detail");
    expect(render()).not.toContain("<code>");
  });
});
