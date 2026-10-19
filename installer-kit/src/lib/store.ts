import type { Charger, Site } from "./types";

type Db = { sites: Map<string, Site>; chargers: Map<string, Charger> };
const g = globalThis as unknown as { __installerKit?: Db };

/** In-memory store: fine for the demo and a single instance; swap for a database in production. */
export function db(): Db {
  g.__installerKit ??= { sites: new Map(), chargers: new Map() };
  return g.__installerKit;
}
