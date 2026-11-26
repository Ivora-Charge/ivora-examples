import { State, utc } from "../ui/kit";
import type { AppTokenState, DriverRow } from "./actions";

export function AccountState({ status }: { status: DriverRow["status"] }) {
  return status === "active" ? (
    <State kind="ok">Active</State>
  ) : (
    <State kind="bad">Blocked</State>
  );
}

const APP_TOKEN: Record<AppTokenState, ["ok" | "off" | "bad", string]> = {
  active: ["ok", "Active"],
  blocked: ["bad", "Blocked"],
  expired: ["bad", "Expired"],
  none: ["off", "None"],
};

export function AppToken({ state }: { state: AppTokenState }) {
  const [kind, word] = APP_TOKEN[state];
  return <State kind={kind}>{word}</State>;
}

/** The last sign-in: accounts from before it was kept have none recorded. */
export const lastSignIn = (iso: string | null) =>
  iso ? utc(iso) : "not recorded";

/** Open problem reports: "2", or "2+" when not every open report was read. */
export const problemCount = (n: number, capped?: boolean) =>
  `${n}${capped ? "+" : ""}`;
