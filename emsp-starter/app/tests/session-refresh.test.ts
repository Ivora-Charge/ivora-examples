import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, refreshSession } from "../src/lib/api";
import {
  isRejected,
  keepSessionFresh,
  REFRESH_LEAD_MS,
  refreshIn,
  RETRY_FIRST_MS,
  RETRY_MAX_MS,
  retryIn,
} from "../src/lib/session-refresh";
import type { AuthSession } from "../src/lib/types";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const session = (minutes: number, n = 1): AuthSession => ({
  accessToken: `access-${n}`,
  refreshToken: `refresh-${n}`,
  expiresAt: new Date(NOW + minutes * 60_000).toISOString(),
});

describe("when to refresh", () => {
  it("refreshes a minute before the access token expires, or at once", () => {
    expect(refreshIn(session(10), NOW)).toBe(10 * 60_000 - REFRESH_LEAD_MS);
    expect(refreshIn(session(0.5), NOW)).toBe(0);
    expect(refreshIn(session(-30), NOW)).toBe(0);
  });

  it("waits longer after each failed try, up to a limit", () => {
    expect(retryIn(0)).toBe(RETRY_FIRST_MS);
    expect(retryIn(1)).toBe(RETRY_FIRST_MS * 2);
    expect(retryIn(20)).toBe(RETRY_MAX_MS);
  });
});

describe("the refresh call (HTTP mocked)", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.EXPO_PUBLIC_API_URL = "https://emsp.example";
    delete process.env.EXPO_PUBLIC_DEMO_MODE;
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllGlobals();
  });

  const answer = (status: number) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status })),
    );
  const failure = (run: () => Promise<unknown>) =>
    run().then(
      () => undefined,
      (e: unknown) => e,
    );

  it.each([400, 401])(
    "counts a %i (refresh token turned down) as rejected",
    async (status) => {
      answer(status);
      expect(isRejected(await failure(() => refreshSession("r")))).toBe(true);
    },
  );

  it.each([429, 500, 503])(
    "does not count a %i as rejected (keep the session, try again)",
    async (status) => {
      answer(status);
      expect(isRejected(await failure(() => refreshSession("r")))).toBe(false);
    },
  );

  it("does not count being offline as rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const e = await failure(() => refreshSession("r"));
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe("unreachable");
    expect(isRejected(e)).toBe(false);
  });
});

describe("keeping the session fresh while the app is open", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  const keeper = (s: AuthSession, refresh: (t: string) => Promise<unknown>) => {
    const onRefreshed = vi.fn();
    const onRejected = vi.fn();
    const stop = keepSessionFresh(s, {
      refresh: refresh as (t: string) => Promise<AuthSession>,
      onRefreshed,
      onRejected,
    });
    return { onRefreshed, onRejected, stop };
  };

  it("refreshes shortly before expiry, not earlier", async () => {
    const refresh = vi.fn(async () => session(60, 2));
    const k = keeper(session(10), refresh);
    await vi.advanceTimersByTimeAsync(10 * 60_000 - REFRESH_LEAD_MS - 1);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledWith("refresh-1");
    expect(k.onRefreshed).toHaveBeenCalledWith(session(60, 2));
    expect(k.onRejected).not.toHaveBeenCalled();
  });

  it("refreshes an expired session at once (as at launch)", async () => {
    const refresh = vi.fn(async () => session(60, 2));
    const k = keeper(session(-120), refresh);
    await vi.advanceTimersByTimeAsync(0);
    expect(k.onRefreshed).toHaveBeenCalledOnce();
  });

  it("keeps the session when offline, and tries again with a growing wait", async () => {
    const offline = new ApiError("unreachable", "offline");
    const refresh = vi
      .fn<(t: string) => Promise<AuthSession>>()
      .mockRejectedValueOnce(offline)
      .mockRejectedValueOnce(new ApiError("http_503", "busy"))
      .mockResolvedValueOnce(session(60, 2));
    const k = keeper(session(-1), refresh);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(k.onRejected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(RETRY_FIRST_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RETRY_FIRST_MS * 2 - 1);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(k.onRefreshed).toHaveBeenCalledWith(session(60, 2));
    expect(k.onRejected).not.toHaveBeenCalled();
  });

  it("signs out only when the server turns the refresh token down", async () => {
    const refresh = vi.fn(async () => {
      throw new ApiError("unauthorized", "no");
    });
    const k = keeper(session(-1), refresh);
    await vi.advanceTimersByTimeAsync(0);
    expect(k.onRejected).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 2);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does nothing more once stopped (signed out meanwhile)", async () => {
    let resolve: (s: AuthSession) => void = () => {};
    const refresh = vi.fn(() => new Promise<AuthSession>((r) => (resolve = r)));
    const k = keeper(session(-1), refresh);
    await vi.advanceTimersByTimeAsync(0);
    k.stop();
    resolve(session(60, 2));
    await vi.advanceTimersByTimeAsync(0);
    expect(k.onRefreshed).not.toHaveBeenCalled();

    const later = vi.fn(async () => session(60, 3));
    keeper(session(10), later).stop();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(later).not.toHaveBeenCalled();
  });
});
