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
import { keepSessionFresh } from "../lib/session-refresh";
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

/**
 * The signed-in driver, kept between launches (see session-store). The session is
 * refreshed shortly before its access token expires, at launch too when it already
 * has (see session-refresh). Being offline or a server error keeps the driver signed
 * in and tries again later; only a refresh token the server turns down (400 or 401)
 * signs the driver out.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<Auth>({ state: "loading" });
  const [stored, setStored] = useState<Stored | null>(null);

  useEffect(() => {
    let live = true;
    void loadSession().then((s) => {
      if (!live) return;
      setStored(s);
      setAuth(
        s ? { state: "signedIn", driver: s.driver } : { state: "signedOut" },
      );
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!stored) return;
    return keepSessionFresh(stored.session, {
      refresh: api.refreshSession,
      onRefreshed: (session) => {
        const next = { ...stored, session };
        void saveSession(next);
        setStored(next);
      },
      onRejected: () => {
        void saveSession(null);
        setStored(null);
        setAuth({ state: "signedOut" });
      },
    });
  }, [stored]);

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
