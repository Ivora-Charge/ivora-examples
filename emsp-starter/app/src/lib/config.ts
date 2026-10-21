/**
 * App settings. EXPO_PUBLIC_ variables are built into the app and readable by anyone,
 * so they hold only the server's address, never a secret. Expo inlines each one at
 * build time, so they must be read as `process.env.EXPO_PUBLIC_<NAME>` literally.
 */
const clean = (v: string | undefined) => v?.trim() || undefined;

export const config = {
  /** Origin of the eMSP Starter server, without a trailing slash. Empty in offline demo. */
  get apiUrl(): string {
    return (clean(process.env.EXPO_PUBLIC_API_URL) ?? "").replace(/\/+$/, "");
  },
};

/**
 * The app's demo-mode switch. With no server URL (or EXPO_PUBLIC_DEMO_MODE=true) the
 * app runs offline on built-in sample data and sends no network request at all.
 * With a URL it talks to the server, which may itself be in demo mode; the server
 * says so in its status and the app shows the same banner.
 */
export function isOfflineDemo(): boolean {
  const forced = clean(process.env.EXPO_PUBLIC_DEMO_MODE)?.toLowerCase();
  if (forced && ["true", "1", "yes", "on"].includes(forced)) return true;
  return !config.apiUrl;
}
