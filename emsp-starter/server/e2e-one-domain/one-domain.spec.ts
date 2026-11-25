import { expect, test, type Page, type Request } from "@playwright/test";
import { signIn } from "../e2e/support";
import { DEMO, WITH_ADMIN } from "../playwright.one-domain.config";

/**
 * One origin serves the driver app at / and the admin at /admin. The app here is
 * built with this origin as its API, and no APP_ORIGINS is set: it works without
 * CORS. The map's tiles are the one thing from outside, and are blocked.
 */
const TILES = /tiles\.openfreemap\.org/;
const SECURITY = [
  "content-security-policy",
  "x-content-type-options",
  "referrer-policy",
] as const;
const ADMIN_SENT = ["frame-ancestors 'none'", "nosniff", "strict-origin"];
const APP_SENT = [
  "frame-ancestors 'none'",
  "nosniff",
  "strict-origin-when-cross-origin",
];
const SIGN_IN_PROMPT = "Sign in as an admin to see this deployment's setup";

const securityOf = (headers: Record<string, string>) =>
  SECURITY.map((name) => headers[name]);

/** What the page asks for, and anything its Content-Security-Policy refuses. */
async function watch(page: Page) {
  const requests: Request[] = [];
  const refused: string[] = [];
  page.on("request", (r) => requests.push(r));
  page.on("console", (m) => {
    if (/Content Security Policy|CORS policy/i.test(m.text()))
      refused.push(m.text());
  });
  await page.route(TILES, (r) => r.abort());
  const outside = () =>
    requests
      .map((r) => r.url())
      .filter(
        (url) =>
          !url.startsWith(`${DEMO.url}/`) &&
          !TILES.test(url) &&
          !/^(blob|data):/.test(url),
      );
  const api = () =>
    requests.filter((r) => r.url().startsWith(`${DEMO.url}/api/v1/`));
  return { requests, refused, outside, api };
}

test("/ opens the driver app, which asks this origin's API and passes its own policy", async ({
  page,
}) => {
  const seen = await watch(page);
  const res = await page.goto("/");
  expect(res!.status()).toBe(200);
  expect(securityOf(res!.headers())).toEqual(APP_SENT);
  await expect(page).toHaveTitle("Kilolane");
  // The server is in demo mode and says so; the chargers come from its API.
  await expect(page.getByTestId("demo-banner")).toBeVisible();
  await expect(page.getByTestId("place-Station Square")).toBeVisible();
  const asked = seen.api().map((r) => new URL(r.url()).pathname);
  expect(asked).toContain("/api/v1/status");
  expect(asked).toContain("/api/v1/locations");
  expect(seen.refused).toEqual([]);
  expect(seen.outside()).toEqual([]);
});

test("a deep link opens the app, and so does reloading it", async ({
  page,
  request,
}) => {
  const seen = await watch(page);
  const res = await page.goto("/account");
  expect(res!.status()).toBe(200);
  expect(securityOf(res!.headers())).toEqual(APP_SENT);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  const again = await page.reload();
  expect(again!.status()).toBe(200);
  await expect(page).toHaveURL(`${DEMO.url}/account`);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  // A link with a segment of its own, to a charger the API knows.
  const search = await request.get("/api/v1/locations");
  const { id } = (await search.json()).items[0];
  await page.goto(`/location/${id}`);
  await expect(page.getByTestId("detail-name")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("detail-name")).toBeVisible();
  expect(seen.refused).toEqual([]);
  expect(seen.outside()).toEqual([]);
});

test("every path that is not the server's own is the app's", async ({
  request,
}) => {
  const app = await (await request.get("/index.html")).text();
  expect(app).toContain('id="root"');
  // Names that only begin like one of the server's are the app's too.
  for (const path of [
    "/",
    "/account",
    "/wallet",
    "/administrator",
    "/apix",
    "/ocpi-guide",
    "/receipt/00000000-0000-4000-8000-000000000000",
    "/.driver-web.json",
  ]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    expect(await res.text(), path).toBe(app);
    expect(securityOf(res.headers()), path).toEqual(APP_SENT);
  }
  // The app's own files are served as they are.
  for (const [, path] of app.matchAll(/(?:src|href)="(\/_expo\/[^"]+)"/g)) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    expect(res.headers()["content-type"], path).toMatch(/javascript|css/);
    expect(securityOf(res.headers()), path).toEqual(APP_SENT);
  }
  const worker = await request.get("/maplibre-gl-worker.mjs");
  expect(worker.headers()["content-type"]).toContain("javascript");
  // Under the server's own paths, an address that names nothing is not the app.
  for (const path of [
    "/admin/no-such-page",
    "/Admin",
    "/api",
    "/api/no-such-page",
    "/ocpi",
    "/ocpi/no-such-page",
    "/_next/no-such-file",
  ]) {
    const res = await request.get(path, { headers: { Accept: "text/html" } });
    expect(res.status(), path).toBe(404);
    expect(await res.text(), path).not.toContain('id="expo-reset"');
    expect(securityOf(res.headers()), path).toEqual(ADMIN_SENT);
  }
});

test("/admin shows a visitor Setup as before: the six names before the first admin, and the sign-in prompt", async ({
  page,
}) => {
  const res = await page.goto("/admin");
  expect(res!.status()).toBe(200);
  expect(securityOf(res!.headers())).toEqual(ADMIN_SENT);
  await expect(page).toHaveTitle("Setup · Kilolane");
  await expect(
    page.getByRole("heading", { name: SIGN_IN_PROMPT }),
  ).toBeVisible();
  const progress = page.getByRole("list", { name: "Setup progress" });
  await expect(progress.getByRole("listitem")).toHaveCount(6);
  await expect(progress.getByText("Not done")).toHaveCount(6);
  await expect(page.getByRole("list", { name: "Setup checklist" })).toHaveCount(
    0,
  );
  // The sign-in link and the menu stay inside the admin.
  await page.getByRole("main").getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${DEMO.url}/admin/sign-in`);
});

test("/admin shows the sign-in prompt alone once an admin exists", async ({
  page,
}) => {
  await page.goto(`${WITH_ADMIN.url}/admin`);
  await expect(
    page.getByRole("heading", { name: SIGN_IN_PROMPT }),
  ).toBeVisible();
  for (const name of ["Setup progress", "Setup checklist"])
    await expect(page.getByRole("list", { name })).toHaveCount(0);
  await expect(page.getByRole("main")).not.toContainText(
    /Not done|Scheduled job|PUBLIC_BASE_URL|charge\.example\.org/,
  );
});

test("the admin's cookie goes to /admin only: the app signs in and works without it", async ({
  page,
  context,
}) => {
  await signIn(page);
  const cookies = await context.cookies();
  expect(cookies.map((c) => [c.name, c.path])).toEqual([
    ["emsp_admin_secret_session", "/admin"],
  ]);

  const seen = await watch(page);
  await page.goto("/account");
  await page.getByTestId("email-input").fill("driver@example.com");
  await page.getByTestId("send-code").click();
  await page.getByTestId("code-input").fill("000000");
  await page.getByTestId("verify-code").click();
  await expect(page.getByTestId("signed-in-email")).toHaveText(
    "driver@example.com",
  );
  // The app's page, its files and its API calls, the signed-in ones included.
  expect(seen.api().some((r) => r.url().endsWith("/api/v1/auth/verify"))).toBe(
    true,
  );
  for (const r of seen.requests)
    expect((await r.allHeaders())["cookie"] ?? "", r.url()).toBe("");
  expect(seen.refused).toEqual([]);

  // Back in the admin, the session is still there.
  const asked = page.waitForRequest(`${DEMO.url}/admin/sign-in`);
  await page.goto("/admin/sign-in");
  expect((await (await asked).allHeaders())["cookie"]).toContain(
    "emsp_admin_secret_session=",
  );
  await expect(page.getByText("Session in use")).toBeVisible();
  // Signing out deletes it.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in", level: 1 }),
  ).toBeVisible();
  expect(await context.cookies()).toEqual([]);
});

test("the status API and OCPI versions answer programs as before", async ({
  request,
}) => {
  const status = await request.get("/api/v1/status");
  expect(status.status()).toBe(200);
  expect(status.headers()["content-type"]).toContain("application/json");
  expect(status.headers()["access-control-allow-origin"]).toBe("*");
  expect(securityOf(status.headers())).toEqual([
    undefined,
    undefined,
    undefined,
  ]);
  const body = await status.json();
  expect(Object.keys(body).sort()).toEqual(["mode", "name", "ocpi"]);
  expect(body).toMatchObject({ mode: "demo", ocpi: { version: "2.2.1" } });

  const versions = await request.get("/ocpi/versions", {
    headers: { "X-Request-ID": "e2e-req" },
  });
  // Without a token: the handler's own refusal, in the OCPI envelope.
  expect(versions.status()).toBe(401);
  expect(versions.headers()["content-type"]).toContain("application/json");
  expect(versions.headers()["x-request-id"]).toBe("e2e-req");
  expect(securityOf(versions.headers())).toEqual([
    undefined,
    undefined,
    undefined,
  ]);
  expect(await versions.json()).toMatchObject({ status_code: 2000 });
});
