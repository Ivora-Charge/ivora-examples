import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADMIN_HEADERS,
  DRIVER_HEADERS,
  NOT_THE_SERVERS,
  webConfig,
} from "@/next.config";
import {
  appEnvironment,
  copyDriverWeb,
  onlyCached,
  RECORD,
  removeDriverWeb,
} from "@/scripts/driver-web.mjs";

// What one origin serves (next.config.ts) and how the driver app's web build gets
// into public/ (scripts/driver-web.mjs). The router itself is tested in
// e2e-one-domain/ and, without the app, in e2e/shell.spec.ts.

const values = (headers: { key: string; value: string }[]) =>
  Object.fromEntries(headers.map((h) => [h.key, h.value]));

describe("the web layout", () => {
  it("with the app: it gets every path that is not the server's, after every file and route", async () => {
    const config = webConfig(true);
    expect(await config.rewrites!()).toEqual({
      beforeFiles: [],
      afterFiles: [],
      fallback: [{ source: NOT_THE_SERVERS, destination: "/index.html" }],
    });
    expect(await config.redirects!()).toEqual([]);
  });

  it("without the app: / leads to /admin for now, and nothing else moves", async () => {
    const config = webConfig(false);
    expect(await config.redirects!()).toEqual([
      { source: "/", destination: "/admin", permanent: false },
    ]);
    expect(await config.rewrites!()).toMatchObject({ fallback: [] });
  });

  it("admin and app pages are both unframeable and unsniffed, each with its referrer policy", () => {
    expect(values(ADMIN_HEADERS)).toEqual({
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin",
    });
    expect(values(DRIVER_HEADERS)).toEqual({
      ...values(ADMIN_HEADERS),
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
  });

  it("sends the app the same headers as the app's own deployment does", () => {
    const vercel = JSON.parse(
      readFileSync(join(__dirname, "../../app/vercel.json"), "utf8"),
    );
    expect(DRIVER_HEADERS).toEqual(vercel.headers[0].headers);
  });

  it("gives the API and OCPI headers on a browser's page load only", async () => {
    for (const driverWeb of [true, false])
      for (const rule of await webConfig(driverWeb).headers!())
        if (/^\/(api|ocpi)\b/.test(rule.source))
          expect(rule.has).toEqual([
            { type: "header", key: "accept", value: ".*text/html.*" },
          ]);
  });
});

describe("the driver app's web build in public/", () => {
  let root: string;
  let dist: string;
  let server: string;
  const write = (path: string, text = "x") => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  const POLICY = `<head><meta http-equiv="Content-Security-Policy" content="default-src 'self'" /></head>`;
  const build = (extra: string[] = []) => {
    rmSync(dist, { recursive: true, force: true });
    write(join(dist, "index.html"), POLICY);
    write(join(dist, "_headers"));
    write(join(dist, "_expo/static/js/web/entry-1.js"));
    for (const path of extra) write(join(dist, path));
  };
  const inPublic = (path: string) => existsSync(join(server, "public", path));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "driver-web-"));
    dist = join(root, "dist");
    server = join(root, "server");
    mkdirSync(server);
    build();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("copies the build, less the file for static hosts, and lists what it copied", () => {
    expect(copyDriverWeb(dist, server)!.sort()).toEqual([
      "_expo",
      "index.html",
    ]);
    expect(inPublic("index.html")).toBe(true);
    expect(inPublic("_expo/static/js/web/entry-1.js")).toBe(true);
    expect(inPublic("_headers")).toBe(false);
    expect(existsSync(join(server, RECORD))).toBe(true);
  });

  it("replaces an earlier copy whole, and takes it out again", () => {
    build(["old.txt"]);
    copyDriverWeb(dist, server);
    build(["_expo/static/js/web/entry-2.js"]);
    rmSync(join(dist, "_expo/static/js/web/entry-1.js"));
    copyDriverWeb(dist, server);
    expect(inPublic("old.txt")).toBe(false);
    expect(inPublic("_expo/static/js/web/entry-1.js")).toBe(false);
    expect(inPublic("_expo/static/js/web/entry-2.js")).toBe(true);
    removeDriverWeb(server);
    expect(existsSync(join(server, "public"))).toBe(false);
    expect(existsSync(join(server, RECORD))).toBe(false);
    // Nothing recorded, nothing to do.
    removeDriverWeb(server);
  });

  it("never overwrites or deletes a file of yours in public/", () => {
    write(join(server, "public/robots.txt"), "mine");
    copyDriverWeb(dist, server);
    removeDriverWeb(server);
    expect(readFileSync(join(server, "public/robots.txt"), "utf8")).toBe(
      "mine",
    );
    build(["robots.txt"]);
    expect(() => copyDriverWeb(dist, server)).toThrow(/robots\.txt/);
    expect(readFileSync(join(server, "public/robots.txt"), "utf8")).toBe(
      "mine",
    );
    expect(inPublic("index.html")).toBe(false);
    expect(existsSync(join(server, RECORD))).toBe(false);
  });

  // Vercel's build cache brings back every node_modules folder, the app's
  // assets/node_modules among them, and nothing else of public/ or the record.
  const restoreFromCache = () => {
    for (const name of ["index.html", "_expo"])
      rmSync(join(server, "public", name), { recursive: true, force: true });
    rmSync(join(server, RECORD));
  };

  it("replaces what a build cache restored of an earlier copy, without the record", () => {
    const FONT = "assets/node_modules/@expo-google-fonts/dm-mono/DMMono.ttf";
    build([FONT]);
    copyDriverWeb(dist, server);
    restoreFromCache();
    expect(inPublic(FONT)).toBe(true);
    build(["assets/node_modules/expo-router/assets/new.png"]);
    expect(copyDriverWeb(dist, server)!.sort()).toEqual([
      "_expo",
      "assets",
      "index.html",
    ]);
    expect(inPublic(FONT)).toBe(false);
    expect(inPublic("assets/node_modules/expo-router/assets/new.png")).toBe(
      true,
    );
    expect(inPublic("index.html")).toBe(true);
    expect(existsSync(join(server, RECORD))).toBe(true);
    // And --remove takes the new copy out whole.
    removeDriverWeb(server);
    expect(existsSync(join(server, "public"))).toBe(false);
  });

  it("still stops at a file of yours beside what the cache restored", () => {
    build(["assets/node_modules/pkg/font.ttf"]);
    copyDriverWeb(dist, server);
    restoreFromCache();
    write(join(server, "public/assets/logo.png"), "mine");
    expect(() => copyDriverWeb(dist, server)).toThrow(
      /public\/ already has assets,/,
    );
    expect(readFileSync(join(server, "public/assets/logo.png"), "utf8")).toBe(
      "mine",
    );
    expect(inPublic("assets/node_modules/pkg/font.ttf")).toBe(true);
    expect(existsSync(join(server, RECORD))).toBe(false);
  });

  it("counts as cached only what lies in a node_modules folder", () => {
    const pub = join(server, "public");
    write(join(pub, "a/node_modules/x/y.js"));
    write(join(pub, "b/node_modules/x.js"));
    write(join(pub, "b/readme.txt"));
    write(join(pub, "c/node_modulesx/y.js"));
    write(join(pub, "node_modules/z.js"));
    write(join(pub, "index.html"));
    mkdirSync(join(pub, "empty"));
    expect(
      ["a", "b", "c", "node_modules", "index.html", "empty"].filter((n) =>
        onlyCached(pub, n),
      ),
    ).toEqual(["a", "node_modules", "empty"]);
  });

  it("rests on git ignoring node_modules folders at any depth", () => {
    const lines = readFileSync(join(__dirname, "../.gitignore"), "utf8")
      .split("\n")
      .map((l) => l.trim());
    expect(lines).toContain("node_modules");
  });

  it("refuses a build without a Content-Security-Policy", () => {
    write(join(dist, "index.html"), "<head></head>");
    expect(() => copyDriverWeb(dist, server)).toThrow(
      /Content-Security-Policy/,
    );
    rmSync(join(dist, "index.html"));
    expect(() => copyDriverWeb(dist, server)).toThrow(/index\.html/);
    expect(existsSync(join(server, "public"))).toBe(false);
  });

  it.each(["admin", "api", "ocpi", "_next", "Admin"])(
    "refuses a build that uses the server's path %s",
    (name) => {
      build([`${name}/page.html`]);
      expect(() => copyDriverWeb(dist, server)).toThrow(/paths of the server/);
      expect(existsSync(join(server, "public"))).toBe(false);
    },
  );

  it.each([["../outside"], [".."], ["."], [""], ["a/b"], [7]])(
    "deletes nothing for a list that names more than files in public/: %s",
    (entry) => {
      write(join(server, "outside"));
      write(join(server, "public/a/b"));
      writeFileSync(
        join(server, RECORD),
        JSON.stringify({ entries: ["a", entry] }),
      );
      expect(() => removeDriverWeb(server)).toThrow(/by hand/);
      expect(existsSync(join(server, "outside"))).toBe(true);
      expect(inPublic("a/b")).toBe(true);
    },
  );
});

describe("what the app's install and build get of the environment", () => {
  const names = (file: string) =>
    [
      ...readFileSync(join(__dirname, "..", file), "utf8").matchAll(
        /^#?\s*([A-Z][A-Z0-9_]+)=/gm,
      ),
    ].map((m) => m[1]);

  it("none of the server's variables, its secrets among them", () => {
    const server = [
      ...names(".env.example"),
      ...names(".env.e2e.example"),
      "SUPABASE_SECRET_KEY",
      "POSTGRES_URL_NON_POOLING",
      "POSTGRES_URL",
      "VERCEL_TOKEN",
      "NODE_ENV",
      "NODE_OPTIONS",
    ];
    expect(server).toEqual(
      expect.arrayContaining([
        "SUPABASE_SERVICE_ROLE_KEY",
        "STRIPE_SECRET_KEY",
        "ADMIN_SECRET",
        "EXPO_ACCESS_TOKEN",
      ]),
    );
    expect(
      appEnvironment(Object.fromEntries(server.map((n) => [n, "value"]))),
    ).toEqual({});
  });

  it("the app's own settings and what npm needs to run", () => {
    const env = {
      PATH: "/bin",
      HOME: "/home/someone",
      CI: "1",
      https_proxy: "http://proxy.example.test",
      npm_config_registry: "https://registry.example.test",
      EXPO_PUBLIC_API_URL: "https://emsp.example.test",
      EXPO_PUBLIC_MAP_STYLE_URL: "none",
      MAP_CONNECT_SRC: "https://tiles.example.test",
      EXPO_NO_TELEMETRY: "1",
    };
    expect(appEnvironment(env)).toEqual(env);
    // Set by `npm run` for the server's folder: not for the app's.
    expect(appEnvironment({ npm_config_local_prefix: "/server" })).toEqual({});
  });
});
