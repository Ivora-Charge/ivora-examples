// Puts the driver app's web build into this server's public/ folder, so that one
// deployment serves the app at / and the admin at /admin (README: One domain).
//
//   node scripts/driver-web.mjs            install, build and copy (build:one-domain)
//   node scripts/driver-web.mjs --remove   take out what an earlier run copied (build)
//
// The app stays its own package: it is installed from its own lockfile and built by its
// own `npm run build`. What is copied is listed in .driver-web.json, which also tells
// next.config.ts that this build serves the app. Only what is listed there, and what
// git could never have held (below), is ever deleted: other files in public/ are yours.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RECORD = ".driver-web.json";

/** First path segments that are the server's own: the app's build may not use them. */
const RESERVED = ["admin", "api", "ocpi", "_next"];
/** For static hosts that read it: this server sends its headers from next.config.ts. */
const NOT_COPIED = ["_headers"];

/** The name of one file or folder directly in public/, never a path out of it. */
const isEntry = (name) =>
  typeof name === "string" &&
  name !== "" &&
  name !== "." &&
  name !== ".." &&
  !/[/\\]/.test(name);

/**
 * Whether every file of the entry `name` in `publicDir` lies in a node_modules folder.
 * git ignores those (.gitignore), so no commit of yours put them there: they are what a
 * host's build cache restored of an earlier copy. Vercel's restores every node_modules
 * folder, the app's assets/node_modules among them, but not the record at the root.
 */
export function onlyCached(publicDir, name) {
  const walk = (path, inModules) => {
    if (!lstatSync(path).isDirectory()) return inModules;
    return readdirSync(path).every((n) =>
      walk(join(path, n), inModules || n === "node_modules"),
    );
  };
  return walk(join(publicDir, name), name === "node_modules");
}

/** Takes out of public/ what `.driver-web.json` of the server in `dir` lists. */
export function removeDriverWeb(dir) {
  const record = join(dir, RECORD);
  if (!existsSync(record)) return;
  const { entries } = JSON.parse(readFileSync(record, "utf8"));
  if (!Array.isArray(entries) || !entries.every(isEntry))
    throw new Error(
      `${RECORD} is not a list of files in public/. Delete it, and the driver app's files in public/, by hand.`,
    );
  const publicDir = join(dir, "public");
  for (const name of entries)
    rmSync(join(publicDir, name), { recursive: true, force: true });
  rmSync(record);
  if (existsSync(publicDir) && readdirSync(publicDir).length === 0)
    rmdirSync(publicDir);
}

/**
 * Copies the app's web build in `dist` into public/ of the server in `dir`, in place
 * of what an earlier run copied. It refuses, and copies nothing, when the build has no
 * Content-Security-Policy, uses a path of the server's, or would overwrite a file in
 * public/ that no earlier run put there. What a build cache restored of an earlier
 * copy, without the record, is replaced too (onlyCached).
 */
export function copyDriverWeb(dist, dir) {
  const index = join(dist, "index.html");
  // The app shares the admin's origin: never serve it without its policy.
  if (
    !existsSync(index) ||
    !/<meta http-equiv="Content-Security-Policy"/.test(
      readFileSync(index, "utf8"),
    )
  )
    throw new Error(
      "The app's web build has no index.html with a Content-Security-Policy. Build it with `npm run build` in the app folder.",
    );
  const entries = readdirSync(dist).filter((n) => !NOT_COPIED.includes(n));
  const taken = entries.filter((n) => RESERVED.includes(n.toLowerCase()));
  if (taken.length)
    throw new Error(
      `The app's web build uses paths of the server's: ${taken.join(", ")}.`,
    );
  removeDriverWeb(dir);
  const publicDir = join(dir, "public");
  const there = entries.filter((n) => existsSync(join(publicDir, n)));
  const mine = there.filter((n) => !onlyCached(publicDir, n));
  if (mine.length)
    throw new Error(
      `public/ already has ${mine.join(", ")}, which the driver app's build would overwrite. Move them first.`,
    );
  for (const name of there)
    rmSync(join(publicDir, name), { recursive: true, force: true });
  mkdirSync(publicDir, { recursive: true });
  // Written first, so that a copy cut short can still be taken out.
  writeFileSync(join(dir, RECORD), `${JSON.stringify({ entries })}\n`);
  for (const name of entries)
    cpSync(join(dist, name), join(publicDir, name), { recursive: true });
  return entries;
}

// What the app's install and build get of this process's environment. The server's
// secrets are not on the list, so no script of the app's packages can read them.
const FOR_THE_APP =
  /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TMPDIR|TMP|TEMP|SYSTEMROOT|COMSPEC|PATHEXT|LANG|LC_ALL|CI|XDG_CACHE_HOME|(HTTP|HTTPS|NO)_PROXY|NODE_EXTRA_CA_CERTS|NPM_CONFIG_(REGISTRY|CACHE|USERCONFIG))$/i;
// Matched as written: these are the app's own settings.
const APP_SETTINGS =
  /^(EXPO_PUBLIC_[A-Z0-9_]+|EXPO_NO_TELEMETRY|EXPO_OFFLINE|MAP_CONNECT_SRC)$/;

export function appEnvironment(env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => FOR_THE_APP.test(name) || APP_SETTINGS.test(name),
    ),
  );
}

function main(args) {
  const server = fileURLToPath(new URL("..", import.meta.url));
  if (args.includes("--remove")) return removeDriverWeb(server);
  // Out first: a build that fails below leaves no older app behind.
  removeDriverWeb(server);
  const app = resolve(server, "../app");
  if (!existsSync(join(app, "package.json")))
    throw new Error(
      "The driver app is not beside the server (../app). The one-domain build needs the whole template folder (README: One domain).",
    );
  const env = { ...appEnvironment(process.env), EXPO_NO_TELEMETRY: "1" };
  for (const command of [["ci"], ["run", "build"]]) {
    const { status } = spawnSync("npm", command, {
      cwd: app,
      env,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (status !== 0)
      throw new Error(`\`npm ${command.join(" ")}\` failed in the app folder.`);
  }
  copyDriverWeb(join(app, "dist"), server);
  console.log(
    env.EXPO_PUBLIC_API_URL?.trim()
      ? "The driver app's web build is in public/: this server serves it at /."
      : "The driver app's web build is in public/, built without EXPO_PUBLIC_API_URL: at / it runs its offline demo and never calls this server.",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}
