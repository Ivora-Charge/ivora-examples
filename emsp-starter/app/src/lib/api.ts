import sample from "../demo/locations.json";
import { config, isOfflineDemo } from "./config";
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
  init: { method?: "GET" | "POST"; body?: unknown; token?: string } = {},
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
