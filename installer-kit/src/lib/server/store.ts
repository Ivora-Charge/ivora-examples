import "server-only";
import { EventDeduper } from "../webhook";
import type { Charger, Site } from "../types";

type Db = {
  sites: Map<string, Site>;
  chargers: Map<string, Charger>;
  /** Sticker code -> charger and connector it was printed for. */
  codes: Map<string, { chargerId: string; connectorNumber: number }>;
  events: EventDeduper;
};

const g = globalThis as unknown as { __installerKit?: Db };

/**
 * In-memory store: enough for the demo and a single instance. Swap it for a
 * database before production; sticker codes in particular must be kept for
 * as long as stickers are on walls.
 */
export function db(): Db {
  g.__installerKit ??= {
    sites: new Map(),
    chargers: new Map(),
    codes: new Map(),
    events: new EventDeduper(),
  };
  return g.__installerKit;
}

export function resetStoreForTests() {
  delete g.__installerKit;
}
