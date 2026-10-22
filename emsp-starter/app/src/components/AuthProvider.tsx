import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import * as api from "../lib/api";
import { loadSession, saveSession, type Stored } from "../lib/session-store";
import type { Driver } from "../lib/types";

type Auth =
  | { state: "loading" }
  | { state: "signedOut" }
  | { state: "signedIn"; driver: Driver };

type AuthApi = Auth & {
  /** Signs in with the emailed code; throws ApiError on a wrong code or a limit. */
  signIn: (email: string, code: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthApi>({
  state: "loading",
  signIn: async () => {},
  signOut: async () => {},
});

const expired = (s: Stored) =>
  Date.parse(s.session.expiresAt) - 60_000 < Date.now();

/**
 * The signed-in driver, kept between launches (see session-store). An expired access
 * token is refreshed once at start; when that fails, the driver signs in again.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<Auth>({ state: "loading" });
  const [stored, setStored] = useState<Stored | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      let s = await loadSession();
      if (s && expired(s)) {
        try {
          s = {
            ...s,
            session: await api.refreshSession(s.session.refreshToken),
          };
          await saveSession(s);
        } catch {
          s = null;
          await saveSession(null);
        }
      }
      if (!live) return;
      setStored(s);
      setAuth(
        s ? { state: "signedIn", driver: s.driver } : { state: "signedOut" },
      );
    })();
    return () => {
      live = false;
    };
  }, []);

  const signIn = useCallback(async (email: string, code: string) => {
    const s = await api.verifyCode(email, code);
    await saveSession(s);
    setStored(s);
    setAuth({ state: "signedIn", driver: s.driver });
  }, []);

  const signOut = useCallback(async () => {
    const token = stored?.session.accessToken;
    await saveSession(null);
    setStored(null);
    setAuth({ state: "signedOut" });
    // Best effort: the device has already forgotten the session.
    if (token) await api.signOut(token).catch(() => {});
  }, [stored]);

  const value = useMemo(
    () => ({ ...auth, signIn, signOut }),
    [auth, signIn, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
