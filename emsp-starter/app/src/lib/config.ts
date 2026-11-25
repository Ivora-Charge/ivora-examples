/**
 * App settings. EXPO_PUBLIC_ variables are built into the app and readable by anyone,
 * so they hold only addresses and public map settings, never a secret. Expo inlines
 * each one at build time, so they must be read as `process.env.EXPO_PUBLIC_<NAME>`
 * literally.
 */
const clean = (v: string | undefined) => v?.trim() || undefined;
/** A link the app may open: https only, anything else counts as not set. */
const httpsUrl = (v: string | undefined) => {
  const url = clean(v);
  return url && /^https:\/\//i.test(url) ? url : undefined;
};

export const config = {
  /** Origin of the eMSP Starter server, without a trailing slash. Empty in offline demo. */
  get apiUrl(): string {
    return (clean(process.env.EXPO_PUBLIC_API_URL) ?? "").replace(/\/+$/, "");
  },
  /**
   * The map. Empty: the app's own style, coloured from the brand tokens, on the free
   * OpenFreeMap vector tiles (no key, no account). A URL: your map provider's style
   * JSON, which may carry a public, domain- or app-restricted key (see the README).
   * `none`: no tiles at all, only the chargers on a plain background.
   */
  get mapStyle(): string | undefined {
    return clean(process.env.EXPO_PUBLIC_MAP_STYLE_URL);
  },
  /** A dark style for dark mode, when `mapStyle` is a URL. Default: the same style. */
  get mapStyleDark(): string | undefined {
    return clean(process.env.EXPO_PUBLIC_MAP_STYLE_URL_DARK);
  },
  /** Attribution your map provider requires, shown on the map. */
  get mapAttribution(): string | undefined {
    return clean(process.env.EXPO_PUBLIC_MAP_ATTRIBUTION);
  },
  /** Where the attribution links to, as your map provider asks (its copyright page). */
  get mapAttributionUrl(): string | undefined {
    return httpsUrl(process.env.EXPO_PUBLIC_MAP_ATTRIBUTION_URL);
  },
  /**
   * Where drivers get your phone apps (their store pages), linked from the web build
   * where it says a card is saved in the phone app. Empty: the words alone.
   */
  get iosAppUrl(): string | undefined {
    return httpsUrl(process.env.EXPO_PUBLIC_IOS_APP_URL);
  },
  get androidAppUrl(): string | undefined {
    return httpsUrl(process.env.EXPO_PUBLIC_ANDROID_APP_URL);
  },
};

/**
 * The app's demo-mode switch. With no server URL (or EXPO_PUBLIC_DEMO_MODE=true) the
 * app runs offline on built-in sample data and sends no request to any server: no
 * sign-in email, no search, no charge. The map's tiles are public map data, not
 * driver data, and come from the map provider (see `mapStyle`).
 * With a URL it talks to the server, which may itself be in demo mode; the server
 * says so in its status and the app shows the same banner.
 */
export function isOfflineDemo(): boolean {
  const forced = clean(process.env.EXPO_PUBLIC_DEMO_MODE)?.toLowerCase();
  if (forced && ["true", "1", "yes", "on"].includes(forced)) return true;
  return !config.apiUrl;
}
