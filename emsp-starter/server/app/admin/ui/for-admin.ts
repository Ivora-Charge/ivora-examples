import "server-only";
import { requestAdmin } from "./current-admin";

/**
 * Reads something about this deployment's configuration only for an admin signed in by
 * email (the session cookie), and gives null for everyone else, without reading it.
 *
 * Every page that hands a setting, an address or "is it set" to the browser goes
 * through this, so a visitor's HTML and page data carry none of it. An admin-secret
 * sign-in lives in the page's memory, which the server cannot see when it renders: it
 * gets null too, and the page says how to find the value by hand.
 */
export async function forEmailAdmin<T>(read: () => T): Promise<T | null> {
  return (await requestAdmin()) ? read() : null;
}
