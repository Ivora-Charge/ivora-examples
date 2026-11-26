import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConfirmCharge from "../src/app/charge/[id]";
import { AuthProvider } from "../src/components/AuthProvider";
import { SAMPLE_LOCATIONS } from "../src/lib/api";

/**
 * The web build's confirm screen for a signed-in driver with no saved card. The offline
 * demo always has cards, so here the app talks to a mocked server whose driver has
 * none. The screen, sign-in, API client and `.web` files are the app's own; only the
 * network and the native-only modules are stood in for.
 */
const PLACE = SAMPLE_LOCATIONS[0];
const API = "https://emsp.example.com";
const EMAIL = "driver@example.com";
const STILL_NONE = "No card on this account yet.";
const FAILED = "Couldn't check your cards. Try again.";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  navigate: vi.fn(),
  dismissTo: vi.fn(),
  back: vi.fn(),
  canGoBack: () => false,
}));
vi.mock("expo-router", () => ({
  router,
  useLocalSearchParams: () => ({ id: PLACE.id }),
}));
vi.mock("expo-localization", () => ({
  getLocales: () => [{ languageTag: "en-GB", languageCode: "en" }],
}));
// Icons are decoration: nothing here reads them.
vi.mock("react-native-svg", () => ({
  default: () => null,
  Circle: () => null,
  Path: () => null,
}));

const card = {
  id: "pm_test",
  brand: "visa",
  last4: "4242",
  expMonth: 12,
  expYear: 2099,
  isDefault: true,
};

/** What `GET /api/v1/cards` answers; tests change it before a check. */
let cards: () => Response | Promise<Response>;
/** Every request the app sent, as "METHOD /path". */
let sent: string[] = [];
let root: Root;
let page: HTMLElement;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const byId = (id: string) =>
  page.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/** The names of everything on the screen that can be pressed as a button or link. */
const actions = () =>
  [...page.querySelectorAll('button, a, [role="button"], [role="link"]')].map(
    (el) => el.getAttribute("aria-label") ?? el.textContent,
  );

const press = (id: string) => act(async () => byId(id)!.click());

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("EXPO_PUBLIC_API_URL", API);
  vi.stubEnv("EXPO_PUBLIC_DEMO_MODE", "");
  vi.stubEnv("EXPO_PUBLIC_IOS_APP_URL", "");
  vi.stubEnv("EXPO_PUBLIC_ANDROID_APP_URL", "");
  cards = () => json({ cards: [] });
  sent = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const { origin, pathname } = new URL(url);
    const request = `${init?.method ?? "GET"} ${pathname}`;
    sent.push(request);
    if (origin === API) {
      if (request === "GET /api/v1/cards") return cards();
      if (request === `GET /api/v1/locations/${PLACE.id}`)
        return json({ location: PLACE });
      if (request === "GET /api/v1/charges/quote")
        return json({
          currency: "EUR",
          holdAmount: 2500,
          mayRaise: false,
          demo: false,
          hasCard: false,
        });
    }
    throw new Error(`Unexpected request: ${request} (${origin})`);
  });
  sessionStorage.setItem(
    "driver-session",
    JSON.stringify({
      session: {
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      },
      driver: {
        id: "driver-without-card",
        email: EMAIL,
        status: "active",
        hasCard: false,
        mode: "live",
      },
    }),
  );

  page = document.body.appendChild(document.createElement("div"));
  root = createRoot(page);
  await act(async () =>
    root.render(
      <AuthProvider>
        <ConfirmCharge />
      </AuthProvider>,
    ),
  );
  await vi.waitFor(() =>
    expect(byId("confirm-hold")?.textContent).toContain("€25.00"),
  );
  // The screen's own loading is over: what is sent from here on, a press sent.
  sent = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  page.remove();
  sessionStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the web confirm screen without a saved card", () => {
  it("says to save one in the phone app, with no Start or Wallet button", () => {
    const notice = byId("confirm-phone-app")!;
    expect(notice.textContent).toContain("Save a card in the phone app");
    expect(notice.textContent).toContain(`signed in as ${EMAIL}`);
    expect(byId("confirm-card")?.textContent).toContain("No card yet");
    expect(byId("confirm-start")).toBeNull();
    expect(byId("confirm-change-card")).toBeNull();
    // These two and no other: nothing starts a charge or leads to the Wallet.
    expect(actions()).toEqual(["Back", "Check for my card"]);
  });

  it("has an empty polite live region before the first check", () => {
    const region = byId("confirm-card-check-live")!;
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
    expect(byId("confirm-phone-app")!.contains(region)).toBe(true);
  });

  it('only re-reads the cards on "Check for my card"', async () => {
    await press("confirm-check-card");
    await vi.waitFor(() =>
      expect(byId("confirm-card-check")?.textContent).toBe(STILL_NONE),
    );
    expect(sent).toEqual(["GET /api/v1/cards"]);
    for (const go of [
      router.push,
      router.replace,
      router.navigate,
      router.dismissTo,
      router.back,
    ])
      expect(go).not.toHaveBeenCalled();
    expect(actions()).toEqual(["Back", "Check for my card"]);
  });

  it("puts each result into the same live region, so a repeat is said again", async () => {
    const region = byId("confirm-card-check-live")!;
    await press("confirm-check-card");
    await vi.waitFor(() => expect(region.textContent).toBe(STILL_NONE));

    // While the next check runs the region is empty, so the same words are new again.
    let answer!: (r: Response) => void;
    cards = () => new Promise<Response>((resolve) => (answer = resolve));
    await press("confirm-check-card");
    expect(region.textContent).toBe("");
    await act(async () => answer(json({ cards: [] })));
    await vi.waitFor(() => expect(region.textContent).toBe(STILL_NONE));

    cards = () => json({}, 500);
    await press("confirm-check-card");
    await vi.waitFor(() => expect(region.textContent).toBe(FAILED));

    // The very element that was there before any result, not a new one.
    expect(byId("confirm-card-check-live")).toBe(region);
    expect(region.isConnected).toBe(true);
    expect(sent).toEqual(Array(3).fill("GET /api/v1/cards"));
  });

  it("offers the start once a check finds a card, and starts nothing itself", async () => {
    cards = () => json({ cards: [card] });
    await press("confirm-check-card");
    await vi.waitFor(() =>
      expect(byId("confirm-start")?.textContent).toBe("Start charging"),
    );
    expect(byId("confirm-phone-app")).toBeNull();
    expect(byId("confirm-change-card")).not.toBeNull();
    expect(sent).toEqual(["GET /api/v1/cards"]);
    expect(router.push).not.toHaveBeenCalled();
  });
});
