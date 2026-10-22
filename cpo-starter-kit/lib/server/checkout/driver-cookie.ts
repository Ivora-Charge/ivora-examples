import "server-only";
import { cookies } from "next/headers";
import { config } from "../env";
import { DRIVER_SESSION_HOURS } from "./service";

const COOKIE = "cpo_driver_sessions";
const MAX = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The taps this browser made (their random request IDs), newest first, so a driver who
 * comes back to the sticker's page sees their own session and only they can start or
 * stop it. The request ID is the capability: it never leaves the kit (the payment's
 * return_reference, which Ivora and Stripe see, is a separate value). HTTP-only; holds
 * no personal data.
 */
export async function driverRequestIds(): Promise<string[]> {
  const raw = (await cookies()).get(COOKIE)?.value ?? "";
  return raw
    .split(".")
    .filter((x) => UUID.test(x))
    .slice(0, MAX);
}

/** Server actions only: remember a tap this browser made. */
export async function rememberDriverRequest(requestId: string) {
  const id = requestId.toLowerCase();
  const ids = [id, ...(await driverRequestIds()).filter((x) => x !== id)];
  (await cookies()).set(COOKIE, ids.slice(0, MAX).join("."), {
    httpOnly: true,
    sameSite: "lax",
    secure: config.appUrl.startsWith("https:"),
    // Site-wide: a payment page's return (a server action elsewhere that redirects
    // to the sticker's page) renders that page in its own request.
    path: "/",
    maxAge: DRIVER_SESSION_HOURS * 3600,
  });
}
