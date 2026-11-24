"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { passes, type SetupStatus } from "@/lib/setup/checks";
import { setupStatusAction, type SetupState } from "../setup/actions";
import { useAdmin } from "./admin-context";
import { useList } from "./use-action";

type SetupContext = {
  /** The last answer of the setup status read; `status` is in it once one came. */
  state: SetupState;
  loading: boolean;
  reload: () => void;
  /** All six checks pass: Setup is called Health, in the menu and on its page. */
  health: boolean;
};

const Ctx = createContext<SetupContext | null>(null);

/** Whether every stop passed when the status was read. */
export const allPass = (status: SetupStatus | undefined): boolean =>
  !!status && passes(status, Date.parse(status.checkedAt)).every(Boolean);

/**
 * The setup status, read once an admin is signed in and shared by the menu (which
 * calls the page Health once all six checks pass) and the page itself. Nothing is read
 * while nobody is signed in, so a visitor's menu always says Setup.
 */
export function SetupProvider({ children }: { children: ReactNode }) {
  const { signedIn } = useAdmin();
  const { state, loading, reload } = useList(setupStatusAction);
  const value = useMemo<SetupContext>(
    () => ({
      state,
      loading,
      reload: () => void reload(),
      health: signedIn && allPass(state.status),
    }),
    [state, loading, reload, signedIn],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSetup(): SetupContext {
  const ctx = useContext(Ctx);
  if (!ctx)
    throw new Error("useSetup needs the SetupProvider of app/layout.tsx");
  return ctx;
}
