import { expect, test, type Page } from "@playwright/test";

const state = (page: Page) => page.waitForResponse("**/api/state");

async function openDepot(page: Page) {
  await page.goto("/depot");
  await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
  const r = state(page);
  await page.getByRole("button", { name: "Reset demo" }).click();
  await r;
  await expect(page.locator(".top .clock")).toHaveText("16:30");
}

// Pairs of child elements whose bounding boxes overlap, or that spill out
// of their parent, for every element matching `rows`.
function overlaps(page: Page, rows: string, kids = ":scope > *") {
  return page.evaluate(
    ([rows, kids]) => {
      const out: string[] = [];
      for (const row of document.querySelectorAll(rows)) {
        const p = row.getBoundingClientRect();
        // The drawn extent: the element's box joined with its text, which
        // can spill out of a too-narrow grid cell.
        const boxes = [...row.querySelectorAll(kids)]
          .filter((e) => e.getClientRects().length > 0)
          .map((e) => {
            const range = document.createRange();
            range.selectNodeContents(e);
            const a = e.getBoundingClientRect();
            const t = range.getBoundingClientRect();
            const r = t.width
              ? {
                  left: Math.min(a.left, t.left),
                  right: Math.max(a.right, t.right),
                  top: Math.min(a.top, t.top),
                  bottom: Math.max(a.bottom, t.bottom),
                }
              : a;
            return { text: e.textContent ?? "", r };
          });
        for (const [i, a] of boxes.entries()) {
          if (a.r.left < p.left - 1 || a.r.right > p.right + 1)
            out.push(`${a.text} leaves its row`);
          for (const b of boxes.slice(i + 1))
            if (
              a.r.left < b.r.right &&
              b.r.left < a.r.right &&
              a.r.top < b.r.bottom &&
              b.r.top < a.r.bottom
            )
              out.push(`${a.text} / ${b.text}`);
        }
      }
      return out;
    },
    [rows, kids],
  );
}

async function advance(page: Page, hours: number) {
  for (let i = 0; i < hours; i++) {
    const r = state(page);
    await page.getByRole("button", { name: "Advance 1 h" }).click();
    await r;
  }
}

test("landing: the demo banner, the Ivora panel, and a way into the console", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("status").filter({ hasText: "Demo" }),
  ).toBeVisible();
  const how = page.getByRole("region", { name: "How it works on Ivora" });
  await expect(how).toContainText("Smart charging profiles");
  await expect(how).toContainText("RFID cards");
  await expect(how).toContainText("Webhooks");
  await expect(
    how.getByRole("link", { name: "Ivora API docs" }),
  ).toHaveAttribute("href", "https://www.ivoracharge.com/developers");
  await page.getByRole("link", { name: "Try the demo" }).click();
  await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
});

test("the night: the at-risk van is flagged, prioritised and turns Ready; every vehicle leaves Ready", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openDepot(page);
  await expect(page.getByText("on route").first()).toBeVisible();
  await expect(page.locator(".row")).toHaveCount(12);
  // Depot time (UTC) in a Pacific browser: the night starts 16:30, the van leaves 06:30.
  await expect(page.locator(".top .tzlab")).toHaveText("Depot time");
  await expect(page.locator(".tl-head .hours span").first()).toHaveText(
    "16:00",
  );
  await expect(
    page.locator(".row", { hasText: "Cargo van 6" }).locator(".dep-time"),
  ).toContainText("06:30");
  // Level 2 and DC chargers are labelled on the rows.
  await expect(page.locator(".ctype.dc").first()).toHaveText("DC fast");
  await expect(page.locator(".ctype.ac").first()).toHaveText("L2 AC");

  // 16:30 to 21:30: the last van plugs in and the depot is at the cap.
  await advance(page, 5);
  const van = page.locator(".row", { hasText: "Cargo van 6" });
  await expect(van.locator(".chip")).toHaveText("at risk");
  await expect(page.locator(".row .chip.late")).toHaveCount(1);
  await expect(page.getByLabel(/Site power over the night/)).toBeVisible();

  // 23:30: the dispatcher moved a departure, so the van is served first and recovers.
  await advance(page, 2);
  await expect(van.locator(".chip")).toHaveText("charging");
  await expect(page.locator(".row .chip.late")).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "Event log" })
      .getByText(/departure moved to 07:15/),
  ).toBeVisible();
  await expect(
    page.getByText("charging_profile.accepted").first(),
  ).toBeVisible();

  // The rest of the night.
  await advance(page, 9);
  await expect(page.locator(".row .chip.ready")).toHaveCount(12);
  await expect(page.locator(".row .chip.late")).toHaveCount(0);
  await expect(page.locator(".peaks")).toContainText(
    /Peak 1[45]\d kW vs 2\d\d kW unmanaged/,
  );
  await expect(page.getByText("The night is over")).toBeVisible();
});

test("60x: the clock runs, the chart fills, pause stops it, reset starts over", async ({
  page,
}) => {
  await openDepot(page);
  const clock = page.locator(".top .clock");
  await page.getByRole("button", { name: "60×" }).click();
  await expect(page.getByRole("button", { name: "60×" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(clock).not.toHaveText("16:30", { timeout: 10_000 });
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const at = await clock.textContent();
  await page.waitForTimeout(2500);
  expect(await clock.textContent()).toBe(at);
  await page.getByRole("button", { name: "Reset demo" }).click();
  await expect(clock).toHaveText("16:30");
});

test("no console errors and no layout shift while the clock runs at 60x", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await openDepot(page);
  await advance(page, 4);
  await page.evaluate(() => {
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as unknown as {
        hadRecentInput: boolean;
        value: number;
      }[])
        if (!e.hadRecentInput) w.__cls += e.value;
    }).observe({ type: "layout-shift", buffered: false });
  });
  await page.getByRole("button", { name: "60×" }).click();
  await page.waitForTimeout(6000);
  await page.getByRole("button", { name: "Pause" }).click();
  const cls = await page.evaluate(
    () => (window as unknown as { __cls: number }).__cls,
  );
  expect(cls).toBeLessThan(0.02);
  expect(errors).toEqual([]);
});

test("cost per vehicle and per driver, and the CSV downloads", async ({
  page,
}) => {
  await openDepot(page);
  await page.getByRole("tab", { name: "Sessions and cost" }).click();
  for (const [by, file] of [
    ["driver", /^depot-driver-\d{4}-\d{2}\.csv$/],
    ["vehicle", /^depot-vehicle-\d{4}-\d{2}\.csv$/],
  ] as const) {
    await page.getByLabel("Group by").selectOption(by);
    await expect(page.locator(".cost li").first()).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Download CSV" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(file);
    const path = await download.path();
    const text = (await import("node:fs")).readFileSync(path, "utf8");
    const lines = text.trim().split("\n");
    expect(lines[0]).toBe("name,sessions,energy_kwh,currency,cost");
    expect(lines.length).toBeGreaterThan(5);
  }
  await page.getByLabel("Month").selectOption("last");
  await expect(page.locator(".cost li").first()).toBeVisible();
});

test("cost shows USD and CAD lists, each in its own currency", async ({
  page,
}) => {
  await openDepot(page);
  await page.getByRole("tab", { name: "Sessions and cost" }).click();
  await page.getByLabel("Group by").selectOption("vehicle");
  await expect(page.getByRole("note")).toContainText("Mixed currencies");
  await expect(page.getByRole("note")).toContainText("CAD, USD");
  const usd = page.getByRole("list", { name: "USD" }).locator(".amt").first();
  const cad = page.getByRole("list", { name: "CAD" }).locator(".amt").first();
  await expect(usd).toHaveText(/^\$[\d,]+\.\d{2}$/);
  await expect(cad).toHaveText(/^CA\$[\d,]+\.\d{2}$/);
  await expect(
    page.getByText("Toronto annex CA$0.22/kWh").first(),
  ).toBeVisible();
});

test("card import is labelled and reports per-line errors", async ({
  page,
}) => {
  await openDepot(page);
  await page.getByRole("tab", { name: "Vehicles and cards" }).click();
  await page.getByRole("button", { name: "Edit" }).first().click();
  await page.getByLabel("Target %").fill("80");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByText("Saved; charging plan recomputed."),
  ).toBeVisible();
  await page
    .getByLabel(/Import cards as CSV/)
    .fill("idTag,driverName\nDEMO7001,Sample Driver\nbad tag!,X");
  await page.getByRole("button", { name: "Import cards (CSV)" }).click();
  await expect(page.getByText(/Imported 1, 1 rejected: line 3/)).toBeVisible();
});

for (const [width, height] of [
  [1920, 1080],
  [1280, 720],
]) {
  test(`wall display fits ${width}x${height} without scrolling`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await openDepot(page);
    await advance(page, 8);
    await page.getByRole("tab", { name: "Settings" }).click();
    await page.getByRole("button", { name: /Wall display/ }).click();
    await expect(
      page.getByRole("heading", { name: "Next departures" }),
    ).toBeVisible();
    await expect(page.locator(".nextlist li")).toHaveCount(6);
    const fits = await page.evaluate(() => {
      const w = document.querySelector(".wall")!;
      return w.scrollHeight <= w.clientHeight && w.scrollWidth <= w.clientWidth;
    });
    expect(fits).toBe(true);
    expect(await overlaps(page, ".nextlist li")).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
  });
}

test("desktop 1440: the status column stays inside the timeline card", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDepot(page);
  await advance(page, 8);
  await expect(page.locator(".row .st small.num").first()).toContainText(
    "(simulated)",
  );
  const spill = await page.evaluate(() => {
    const out: string[] = [];
    for (const row of document.querySelectorAll(".tl-rows .row")) {
      const card = row.closest(".panel")!.getBoundingClientRect();
      for (const e of row.querySelectorAll(".st > *")) {
        const range = document.createRange();
        range.selectNodeContents(e);
        const r = range.getBoundingClientRect();
        if (r.right > card.right - 8) out.push(e.textContent ?? "");
      }
    }
    return out;
  });
  expect(spill).toEqual([]);
  expect(await overlaps(page, ".tl-rows .row")).toEqual([]);
});

test("refuses cross-origin writes", async ({ request }) => {
  const r = await request.post("/api/state", {
    headers: { origin: "https://evil.example" },
    data: { action: "advance", minutes: 60 },
  });
  expect(r.status()).toBe(403);
});

test("phone: mini-timeline labels never overlap as the clock advances", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDepot(page);
  await expect(page.locator(".row").first()).toBeVisible();
  for (let h = 0; h <= 16; h++) {
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 844 });
      const clashes = await page.evaluate(() => {
        const out: string[] = [];
        for (const row of document.querySelectorAll(".tl-rows .row")) {
          const boxes = [...row.querySelectorAll(".tl-lab span")].map((s) => ({
            text: s.textContent ?? "",
            r: s.getBoundingClientRect(),
          }));
          const track = row.querySelector(".track")!.getBoundingClientRect();
          for (const [i, a] of boxes.entries()) {
            if (a.r.left < track.left - 1 || a.r.right > track.right + 1)
              out.push(`${a.text} leaves the track`);
            for (const b of boxes.slice(i + 1))
              if (
                a.r.left < b.r.right &&
                b.r.left < a.r.right &&
                a.r.top < b.r.bottom &&
                b.r.top < a.r.bottom
              )
                out.push(`${a.text} / ${b.text}`);
          }
        }
        return out;
      });
      expect(clashes, `after ${h} h at ${width} px`).toEqual([]);
    }
    const advanceBtn = page.getByRole("button", { name: "Advance 1 h" });
    if (await advanceBtn.isDisabled()) break;
    const r = state(page);
    await advanceBtn.click();
    await r;
  }
});

test("each visitor has their own night: another visitor's clock does not move it", async ({
  browser,
}) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await openDepot(a);
  await openDepot(b);
  await advance(a, 3);
  await expect(a.locator(".top .clock")).toHaveText("19:30");
  await b.reload();
  await expect(b.locator(".top .clock")).toHaveText("16:30");
  // A's night survives a reload: it lives in A's cookie.
  await a.reload();
  await expect(a.locator(".top .clock")).toHaveText("19:30");
  await b.getByRole("button", { name: "Reset demo" }).click();
  await a.reload();
  await expect(a.locator(".top .clock")).toHaveText("19:30");
});

test("Play the night (300x): the at-risk van is flagged, then turns Ready, all leave Ready in about 3 minutes", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openDepot(page);
  const van = page.locator(".row", { hasText: "Cargo van 6" });
  const started = Date.now();
  await page.getByRole("button", { name: "Play the night (300×)" }).click();
  // 21:30-23:00 depot time: on screen for about 18 seconds.
  await expect(van.locator(".chip")).toHaveText("at risk", {
    timeout: 120_000,
  });
  await expect(van.locator(".chip")).toHaveText("charging", {
    timeout: 60_000,
  });
  await expect(page.getByText("The night is over")).toBeVisible({
    timeout: 200_000,
  });
  expect(Date.now() - started).toBeLessThan(240_000);
  await expect(page.locator(".row .chip.ready")).toHaveCount(12);
  await expect(page.locator(".top .clock")).toHaveText("08:30");
});

test("wall display opens from a direct link and keeps the visitor's night", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openDepot(page);
  await advance(page, 2);
  await page.goto("/depot?wall=1");
  await expect(
    page.getByRole("heading", { name: "Next departures" }),
  ).toBeVisible();
  await expect(page.locator(".wall .top .clock")).toHaveText("18:30");
  await expect(page.locator(".nextlist li").first()).toContainText("% now");
  expect(await overlaps(page, ".nextlist li")).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/depot$/);
});
