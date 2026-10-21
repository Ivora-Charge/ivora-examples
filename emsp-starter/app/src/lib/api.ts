import { config, isOfflineDemo } from "./config";

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

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The only place the app makes a network request, and only to its own server.
 * In offline demo mode it refuses before anything is sent.
 */
async function apiGet<T>(path: string): Promise<T> {
  if (isOfflineDemo())
    throw new ApiError("demo_mode", "Offline demo: nothing was sent.");
  let res: Response;
  try {
    res = await fetch(`${config.apiUrl}${path}`, {
      headers: { Accept: "application/json" },
    });
  } catch {
    throw new ApiError("unreachable", "Could not reach the server.");
  }
  if (!res.ok)
    throw new ApiError(
      `http_${res.status}`,
      `The server answered ${res.status}.`,
    );
  return (await res.json()) as T;
}

export async function getStatus(): Promise<Status> {
  if (isOfflineDemo()) return DEMO_STATUS;
  return apiGet<Status>("/api/v1/status");
}
