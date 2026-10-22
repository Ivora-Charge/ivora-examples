import sample from "../demo/locations.json";
import { config, isOfflineDemo } from "./config";
import type {
  Card,
  CardSetup,
  Charge,
  CommandView,
  Favourite,
  HistoryItem,
  PaymentView,
  ProblemReport,
  Quote,
  Receipt,
  SessionState,
} from "./charging";
import { createDemoCharging, DemoError } from "./demo-charge";
import { searchSample, searchParams, type Search } from "./search";
import type {
  AuthSession,
  Driver,
  LocationDetail,
  SearchResult,
} from "./types";

/** `GET /api/v1/status` on the server. */
export type Status = {
  mode: "demo" | "live";
  name: string;
  ocpi: { version: string; country_code: string; party_id: string };
};

/** What the offline demo shows. Matches the server's own demo identity. */
export const DEMO_STATUS: Status = {
  mode: "demo",
  name: "Demo network",
  ocpi: { version: "2.2.1", country_code: "ZZ", party_id: "DMO" },
};

/** The code every demo sign-in takes, as on a server in demo mode. Nothing is emailed. */
export const DEMO_CODE = "000000";

/** The mock CPO's sample locations, made by the server's own code (see the file's comment). */
export const SAMPLE_LOCATIONS = sample.locations as LocationDetail[];

/**
 * An error with a code the screens turn into words: `demo_mode`, `unreachable`,
 * `rate_limited` (with `retryAfter` seconds), `unauthorized`, `invalid`, `not_found`
 * or `http_<status>`.
 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const EMAIL =
  /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;

/**
 * The only place the app makes a network request, and only to its own server.
 * In offline demo mode it refuses before anything is sent.
 */
async function request<T>(
  path: string,
  init: {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    body?: unknown;
    token?: string;
  } = {},
): Promise<T> {
  if (isOfflineDemo())
    throw new ApiError("demo_mode", "Offline demo: nothing was sent.");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  let res: Response;
  try {
    res = await fetch(`${config.apiUrl}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError("unreachable", "Could not reach the server.");
  }
  if (!res.ok) {
    const code =
      res.status === 429
        ? "rate_limited"
        : res.status === 401
          ? "unauthorized"
          : res.status === 400
            ? "invalid"
            : res.status === 404
              ? "not_found"
              : `http_${res.status}`;
    const retry = Number(res.headers.get("retry-after"));
    throw new ApiError(
      code,
      `The server answered ${res.status}.`,
      Number.isFinite(retry) && retry > 0 ? retry : undefined,
    );
  }
  if (res.status === 202 || res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function getStatus(): Promise<Status> {
  if (isOfflineDemo()) return DEMO_STATUS;
  return request<Status>("/api/v1/status");
}

/** Chargers matching a search: the server's location search, or the sample data offline. */
export async function searchLocations(s: Search): Promise<SearchResult> {
  if (isOfflineDemo()) return searchSample(SAMPLE_LOCATIONS, s);
  return request<SearchResult>(`/api/v1/locations?${searchParams(s)}`);
}

/** One location with its chargers, connectors and prices. */
export async function getLocation(id: string): Promise<LocationDetail> {
  if (isOfflineDemo()) {
    const found = SAMPLE_LOCATIONS.find((l) => l.id === id);
    if (!found) throw new ApiError("not_found", "Location not found.");
    return found;
  }
  const body = await request<{ location: LocationDetail }>(
    `/api/v1/locations/${encodeURIComponent(id)}`,
  );
  return body.location;
}

/**
 * Asks for a sign-in code. The answer is the same whether the address has an account
 * or not, so the app cannot tell, and never says, who drives with this network.
 */
export async function requestCode(email: string): Promise<void> {
  const clean = email.trim().toLowerCase();
  if (!EMAIL.test(clean) || clean.length > 254)
    throw new ApiError("invalid", "Enter a valid email address.");
  if (isOfflineDemo()) return;
  await request<void>("/api/v1/auth/code", {
    method: "POST",
    body: { email: clean },
  });
}

const demoSession = (): AuthSession => ({
  accessToken: "offline-demo-session",
  refreshToken: "offline-demo-refresh",
  expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
});

/** Signs in with the emailed code; the first sign-in makes the account. */
export async function verifyCode(
  email: string,
  code: string,
): Promise<{ session: AuthSession; driver: Driver }> {
  const clean = email.trim().toLowerCase();
  const digits = code.replace(/\s/g, "");
  if (!/^[0-9]{6,10}$/.test(digits))
    throw new ApiError("invalid", "Enter the code from the email.");
  if (isOfflineDemo()) {
    if (digits !== DEMO_CODE)
      throw new ApiError("unauthorized", "Wrong or expired code.");
    return {
      session: demoSession(),
      driver: {
        id: "offline-demo-driver",
        email: clean,
        status: "active",
        hasCard: true,
        mode: "demo",
      },
    };
  }
  return request("/api/v1/auth/verify", {
    method: "POST",
    body: { email: clean, code: digits },
  });
}

export async function refreshSession(
  refreshToken: string,
): Promise<AuthSession> {
  if (isOfflineDemo()) return demoSession();
  const body = await request<{ session: AuthSession }>("/api/v1/auth/refresh", {
    method: "POST",
    body: { refreshToken },
  });
  return body.session;
}

export async function getMe(accessToken: string): Promise<Driver> {
  if (isOfflineDemo())
    throw new ApiError("demo_mode", "Offline demo: nothing was sent.");
  const body = await request<{ driver: Driver }>("/api/v1/me", {
    token: accessToken,
  });
  return body.driver;
}

export async function signOut(accessToken: string): Promise<void> {
  if (isOfflineDemo()) return;
  await request<void>("/api/v1/auth/sign-out", {
    method: "POST",
    token: accessToken,
  });
}

/*
 * Charging, payments, history and support (part 11). Every call needs the driver's
 * access token. In the offline demo each one runs on the device (demo-charge.ts) and
 * sends nothing; with a server it is the server that holds the card, sends the charger
 * commands and settles the payment: the app only asks and shows.
 */
const demo = createDemoCharging(SAMPLE_LOCATIONS);

/** Runs `fn` on the offline demo, with its errors as ApiErrors. */
function offline<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (e) {
    return Promise.reject(
      e instanceof DemoError ? new ApiError(e.code, e.message) : e,
    );
  }
}

const enc = encodeURIComponent;

export async function getCards(token: string): Promise<Card[]> {
  if (isOfflineDemo()) return offline(() => demo.cards());
  return (await request<{ cards: Card[] }>("/api/v1/cards", { token })).cards;
}

export async function setupCard(
  token: string,
  input: { requestId: string; stripeVersion: string },
): Promise<CardSetup> {
  if (isOfflineDemo()) return offline(() => demo.setupCard());
  return request<CardSetup>("/api/v1/cards/setup", {
    method: "POST",
    body: input,
    token,
  });
}

export async function setDefaultCard(token: string, id: string) {
  if (isOfflineDemo()) return offline(() => demo.setDefaultCard(id));
  await request("/api/v1/cards/default", {
    method: "PUT",
    body: { paymentMethodId: id },
    token,
  });
}

export async function removeCard(token: string, id: string) {
  if (isOfflineDemo()) return offline(() => demo.removeCard());
  await request(`/api/v1/cards/${enc(id)}`, { method: "DELETE", token });
}

export async function getQuote(
  token: string,
  locationId: string,
  evseUid?: string,
  connectorId?: string,
): Promise<Quote> {
  if (isOfflineDemo())
    return offline(() => demo.quote(locationId, evseUid, connectorId));
  const q = new URLSearchParams({ locationId });
  if (evseUid) q.set("evseUid", evseUid);
  if (connectorId) q.set("connectorId", connectorId);
  return request<Quote>(`/api/v1/charges/quote?${q}`, { token });
}

/** The hold, then START_SESSION, on the server. The same request ID never starts twice. */
export async function startCharge(
  token: string,
  input: {
    requestId: string;
    locationId: string;
    evseUid?: string;
    connectorId?: string;
  },
): Promise<{
  state: "created" | "replayed" | "busy";
  command: CommandView;
  payment: PaymentView | null;
}> {
  if (isOfflineDemo()) return offline(() => demo.start(input));
  return request("/api/v1/charges", { method: "POST", body: input, token });
}

export async function getCharge(
  token: string,
  id: string,
): Promise<{ command: CommandView; payment: PaymentView | null }> {
  if (isOfflineDemo()) return offline(() => demo.charge(id));
  return request(`/api/v1/charges/${enc(id)}`, { token });
}

export async function getActiveCharge(token: string): Promise<Charge | null> {
  if (isOfflineDemo()) return offline(() => demo.active());
  return (
    await request<{ charge: Charge | null }>("/api/v1/charges/active", {
      token,
    })
  ).charge;
}

export async function getChargeSession(
  token: string,
  id: string,
): Promise<SessionState> {
  if (isOfflineDemo()) return offline(() => demo.session(id));
  return request<SessionState>(`/api/v1/charges/${enc(id)}/session`, {
    token,
  });
}

/** STOP_SESSION for the charge's session, on the server. */
export async function stopCharge(
  token: string,
  id: string,
  requestId: string,
): Promise<{ state: string; command: CommandView }> {
  if (isOfflineDemo()) return offline(() => demo.stop(id));
  return request(`/api/v1/charges/${enc(id)}/stop`, {
    method: "POST",
    body: { requestId },
    token,
  });
}

export async function getHistory(token: string): Promise<HistoryItem[]> {
  if (isOfflineDemo()) return offline(() => demo.history());
  return (await request<{ items: HistoryItem[] }>("/api/v1/history", { token }))
    .items;
}

export async function getReceipt(token: string, id: string): Promise<Receipt> {
  if (isOfflineDemo()) return offline(() => demo.receipt(id));
  return (
    await request<{ receipt: Receipt }>(`/api/v1/charges/${enc(id)}/receipt`, {
      token,
    })
  ).receipt;
}

/** Emails the receipt again. The demo sends nothing and says so. */
export async function emailReceipt(
  token: string,
  id: string,
): Promise<{ sent: boolean; demo: boolean }> {
  if (isOfflineDemo()) return { sent: false, demo: true };
  const res = await request<{ sent: boolean; demo: boolean } | undefined>(
    `/api/v1/charges/${enc(id)}/receipt/email`,
    { method: "POST", body: {}, token },
  );
  return res ?? { sent: true, demo: false };
}

export async function getFavourites(token: string): Promise<Favourite[]> {
  if (isOfflineDemo()) return offline(() => demo.favourites());
  return (
    await request<{ favourites: Favourite[] }>("/api/v1/favourites", { token })
  ).favourites;
}

export async function setFavourite(
  token: string,
  locationId: string,
  on: boolean,
) {
  if (isOfflineDemo()) return offline(() => demo.setFavourite(locationId, on));
  await request(`/api/v1/favourites/${enc(locationId)}`, {
    method: on ? "PUT" : "DELETE",
    token,
  });
}

/** A problem at a charger, for the network's admins. */
export async function reportProblem(
  token: string,
  report: ProblemReport,
): Promise<{ id: string }> {
  if (isOfflineDemo()) return offline(() => demo.report(report));
  return request("/api/v1/problems", { method: "POST", body: report, token });
}

/** This device's push token, so the server can say when charging is done. */
export async function savePushToken(
  token: string,
  push: { token: string; platform: "ios" | "android"; locale: string },
) {
  // The offline demo has no server to send a notification: nothing is saved.
  if (isOfflineDemo()) return;
  await request("/api/v1/push-token", { method: "PUT", body: push, token });
}

export async function forgetPushToken(token: string, pushToken: string) {
  if (isOfflineDemo()) return;
  await request("/api/v1/push-token", {
    method: "DELETE",
    body: { token: pushToken },
    token,
  });
}
