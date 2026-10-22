import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { outboundFetch } from "@/lib/server/demo";

/**
 * Passwordless sign-in with Supabase Auth: the driver (or an admin) asks for an email,
 * which carries a one-time code and, if your email template includes it, a link with
 * a token hash. Either one, sent back to us, signs in. Supabase sends the email; we
 * never see a password, because there is none.
 *
 * The server talks to Supabase Auth's REST API (`/auth/v1/...`) through
 * `outboundFetch`, so demo mode never reaches it; demo mode uses `DemoAuth`, which
 * sends nothing and takes the code DEMO_CODE.
 */
export type AuthUser = { id: string; email: string };

export type AuthSession = {
  accessToken: string;
  refreshToken: string;
  /** ISO time the access token expires; refresh before then. */
  expiresAt: string;
  user: AuthUser;
};

/** What a driver sends back from the email: the code, or the link's token hash. */
export type Proof = { email: string; code: string } | { tokenHash: string };

/** Supabase's own limit on emails or attempts was hit: try again later. */
export class AuthRateLimitedError extends Error {
  constructor() {
    super("Too many sign-in attempts. Try again later.");
    this.name = "AuthRateLimitedError";
  }
}

export interface AuthProvider {
  /** Sends the sign-in email. Makes the Auth user if the email is new. */
  sendCode(email: string, redirectTo?: string): Promise<void>;
  /** A session for a right code or link; null for a wrong or expired one. */
  verify(proof: Proof): Promise<AuthSession | null>;
  /** A new session for a refresh token; null when it is no longer valid. */
  refresh(refreshToken: string): Promise<AuthSession | null>;
  /** The user of an access token; null when it is invalid or expired. */
  getUser(accessToken: string): Promise<AuthUser | null>;
  /** Ends the session of an access token. Never throws. */
  signOut(accessToken: string): Promise<void>;
}

type SessionBody = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_at?: unknown;
  expires_in?: unknown;
  user?: { id?: unknown; email?: unknown };
};

const userOf = (u: { id?: unknown; email?: unknown } | undefined) =>
  u && typeof u.id === "string" && typeof u.email === "string"
    ? { id: u.id, email: u.email.toLowerCase() }
    : null;

function sessionOf(body: SessionBody): AuthSession | null {
  const user = userOf(body.user);
  if (
    !user ||
    typeof body.access_token !== "string" ||
    typeof body.refresh_token !== "string"
  )
    return null;
  const expiresAt =
    typeof body.expires_at === "number"
      ? new Date(body.expires_at * 1000)
      : new Date(
          Date.now() +
            (typeof body.expires_in === "number" ? body.expires_in : 3600) *
              1000,
        );
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: expiresAt.toISOString(),
    user,
  };
}

/**
 * Supabase Auth over REST, with the service role key as `apikey` (server-side only).
 * Errors name the endpoint and status only: never the email, code or tokens.
 */
export class SupabaseAuth implements AuthProvider {
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    private readonly transport: typeof outboundFetch = outboundFetch,
  ) {}

  private async call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    bearer?: string,
  ): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = {
      apikey: this.apiKey,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const res = await this.transport(
      `${this.url.replace(/\/+$/, "")}/auth/v1/${path}`,
      {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    if (res.status === 429) throw new AuthRateLimitedError();
    if (res.status >= 500)
      throw new Error(
        `Auth request failed: ${method} ${path.split("?")[0]} (HTTP ${res.status})`,
      );
    return { status: res.status, json };
  }

  async sendCode(email: string, redirectTo?: string) {
    const query = redirectTo
      ? `?redirect_to=${encodeURIComponent(redirectTo)}`
      : "";
    const { status } = await this.call("POST", `otp${query}`, {
      email,
      create_user: true,
    });
    if (status >= 400)
      throw new Error(`Auth request failed: POST otp (HTTP ${status})`);
  }

  async verify(proof: Proof) {
    const body =
      "tokenHash" in proof
        ? { type: "email", token_hash: proof.tokenHash }
        : { type: "email", email: proof.email, token: proof.code };
    const { status, json } = await this.call("POST", "verify", body);
    return status === 200 ? sessionOf(json as SessionBody) : null;
  }

  async refresh(refreshToken: string) {
    const { status, json } = await this.call(
      "POST",
      "token?grant_type=refresh_token",
      { refresh_token: refreshToken },
    );
    return status === 200 ? sessionOf(json as SessionBody) : null;
  }

  async getUser(accessToken: string) {
    const { status, json } = await this.call(
      "GET",
      "user",
      undefined,
      accessToken,
    );
    return status === 200 ? userOf(json as AuthUser) : null;
  }

  async signOut(accessToken: string) {
    try {
      await this.call("POST", "logout?scope=local", {}, accessToken);
    } catch (e) {
      console.error(
        `Sign-out failed: ${e instanceof Error ? e.name : "unknown error"}`,
      );
    }
  }
}

/** The code every demo sign-in takes. Demo mode sends no email. */
export const DEMO_CODE = "000000";
const DEMO_SESSION_MS = 60 * 60 * 1000;

/**
 * Sign-in for demo mode, in memory: nothing is sent, and the code is DEMO_CODE. A new
 * email gets a new user; sessions last an hour, or until the server restarts.
 */
export class DemoAuth implements AuthProvider {
  readonly users = new Map<string, AuthUser>();
  private readonly access = new Map<
    string,
    { user: AuthUser; until: number }
  >();
  private readonly refreshTokens = new Map<string, AuthUser>();

  constructor(private readonly now: () => number = Date.now) {}

  private session(user: AuthUser): AuthSession {
    const accessToken = randomBytes(32).toString("base64url");
    const refreshToken = randomBytes(32).toString("base64url");
    const until = this.now() + DEMO_SESSION_MS;
    this.access.set(accessToken, { user, until });
    this.refreshTokens.set(refreshToken, user);
    return {
      accessToken,
      refreshToken,
      expiresAt: new Date(until).toISOString(),
      user,
    };
  }

  async sendCode(email: string) {
    if (!this.users.has(email))
      this.users.set(email, { id: randomUUID(), email });
  }

  async verify(proof: Proof) {
    if ("tokenHash" in proof || proof.code !== DEMO_CODE) return null;
    const user = this.users.get(proof.email);
    return user ? this.session(user) : null;
  }

  async refresh(refreshToken: string) {
    const user = this.refreshTokens.get(refreshToken);
    if (!user) return null;
    this.refreshTokens.delete(refreshToken);
    return this.session(user);
  }

  async getUser(accessToken: string) {
    const held = this.access.get(accessToken);
    if (!held || held.until <= this.now()) return null;
    return held.user;
  }

  async signOut(accessToken: string) {
    this.access.delete(accessToken);
  }
}
