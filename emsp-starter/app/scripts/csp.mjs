// The web build's Content-Security-Policy. `npm run build` runs this after `expo
// export`: it puts the policy in dist/index.html as a <meta> tag and writes
// dist/_headers for hosts that read that file. Serve it as a real
// `Content-Security-Policy` header where you can (see the README), which also allows
// `frame-ancestors`.
//
// The policy: scripts only from the site itself (the export has no inline script);
// styles from the site plus inline ones, which React Native Web and the page's theme
// rules write at run time; requests only to the configured server and the map
// provider; the map's worker from the site.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** The built-in style's tiles, glyphs and sprites (see src/lib/map-style.ts). */
export const OPENFREEMAP_ORIGIN = "https://tiles.openfreemap.org";

const origin = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ||
      (u.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(u.hostname))
      ? u.origin
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The policy for these EXPO_PUBLIC_ settings. `MAP_CONNECT_SRC` (build time only, not
 * built into the app) lists extra origins, separated by spaces, that your map style
 * loads tiles, glyphs or sprites from.
 */
export function contentSecurityPolicy(env = process.env) {
  const v = (k) => env[k]?.trim() || undefined;
  const style = v("EXPO_PUBLIC_MAP_STYLE_URL");
  const map =
    style?.toLowerCase() === "none"
      ? []
      : style
        ? [style, v("EXPO_PUBLIC_MAP_STYLE_URL_DARK")]
        : [OPENFREEMAP_ORIGIN];
  const extra = (v("MAP_CONNECT_SRC") ?? "").split(/\s+/);
  const connect = [
    ...new Set(
      [v("EXPO_PUBLIC_API_URL"), ...map, ...extra]
        .filter(Boolean)
        .map(origin)
        .filter(Boolean),
    ),
  ];
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${["'self'", ...connect].join(" ")}`,
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = new URL("../dist/", import.meta.url);
  const policy = contentSecurityPolicy();
  const index = new URL("index.html", dist);
  const html = await readFile(index, "utf8");
  if (/http-equiv="Content-Security-Policy"/i.test(html))
    throw new Error("dist/index.html already has a Content-Security-Policy");
  await writeFile(
    index,
    html.replace(
      "<head>",
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
    ),
  );
  await writeFile(
    new URL("_headers", dist),
    `/*\n  Content-Security-Policy: ${policy}; frame-ancestors 'none'\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n`,
  );
  console.log(`Content-Security-Policy: ${policy}`);
}
