import type { AuthSession, Driver } from "./types";

export type Stored = { session: AuthSession; driver: Driver };

const KEY = "driver-session";

/**
 * The web build keeps the session in sessionStorage: it lasts while the tab is open
 * and is gone when it closes, so a shared computer does not stay signed in. Native
 * builds use the keychain or keystore instead (`session-store.ts`).
 */
export async function loadSession(): Promise<Stored | null> {
  try {
    const raw = globalThis.sessionStorage?.getItem(KEY);
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

export async function saveSession(value: Stored | null): Promise<void> {
  try {
    if (value) globalThis.sessionStorage?.setItem(KEY, JSON.stringify(value));
    else globalThis.sessionStorage?.removeItem(KEY);
  } catch {}
}
