import * as SecureStore from "expo-secure-store";
import type { AuthSession, Driver } from "./types";

export type Stored = { session: AuthSession; driver: Driver };

const KEY = "driver-session";

/**
 * Where the signed-in driver's session lives between launches: the device's keychain
 * (iOS) or keystore-backed storage (Android). The web build has its own copy of this
 * module, `session-store.web.ts`.
 */
export async function loadSession(): Promise<Stored | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

export async function saveSession(value: Stored | null): Promise<void> {
  if (value) await SecureStore.setItemAsync(KEY, JSON.stringify(value));
  else await SecureStore.deleteItemAsync(KEY);
}
