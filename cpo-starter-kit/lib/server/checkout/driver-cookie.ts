import "server-only";
import { cookies } from "next/headers";
import { config } from "../env";
import { DRIVER_SESSION_HOURS } from "./service";

const COOKIE = "cpo_driver_checkouts";
const MAX = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The checkouts this browser made (their random IDs), newest first, so a driver who
 * comes back to the sticker's page sees their own session and only they can start it.
 * HTTP-only; holds no personal data.
 */
export async function driverCheckoutIds(): Promise<string[]> {
  const raw = (await cookies()).get(COOKIE)?.value ?? "";
  return raw
    .split(".")
    .filter((x) => UUID.test(x))
    .slice(0, MAX);
}

/** Server actions only: remember a checkout this browser made. */
export async function rememberDriverCheckout(id: string) {
  const ids = [id, ...(await driverCheckoutIds()).filter((x) => x !== id)];
  (await cookies()).set(COOKIE, ids.slice(0, MAX).join("."), {
    httpOnly: true,
    sameSite: "lax",
    secure: config.appUrl.startsWith("https:"),
    path: "/c/",
    maxAge: DRIVER_SESSION_HOURS * 3600,
  });
}
