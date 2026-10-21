import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { ApiError, getStatus, type Status } from "../lib/api";
import { isOfflineDemo } from "../lib/config";

type State =
  | { state: "loading" }
  | { state: "ready"; status: Status }
  | { state: "error"; error: ApiError };

const StatusContext = createContext<State>({ state: "loading" });

/** Loads the server status once, for the demo banner and the home screen. */
export function StatusProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<State>({ state: "loading" });
  useEffect(() => {
    let live = true;
    getStatus().then(
      (status) => live && setValue({ state: "ready", status }),
      (e: unknown) =>
        live &&
        setValue({
          state: "error",
          error:
            e instanceof ApiError
              ? e
              : new ApiError("unknown", "Something unexpected went wrong."),
        }),
    );
    return () => {
      live = false;
    };
  }, []);
  return (
    <StatusContext.Provider value={value}>{children}</StatusContext.Provider>
  );
}

export const useStatus = () => useContext(StatusContext);

/** Demo banner rule: offline demo, or a server that reports demo mode. */
export function useDemo(): { demo: boolean; offline: boolean } {
  const s = useStatus();
  const offline = isOfflineDemo();
  return {
    offline,
    demo: offline || (s.state === "ready" && s.status.mode === "demo"),
  };
}
