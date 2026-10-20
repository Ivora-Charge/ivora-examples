import "server-only";
import { config } from "./config";
import type {
  DepotEvent,
  Driver,
  Session,
  Settings,
  Transaction,
  Vehicle,
} from "./types";

export interface Docs {
  vehicles: Vehicle;
  drivers: Driver;
  sessions: Session;
  transactions: Transaction;
  events: DepotEvent & { id: string };
  /** Webhook event IDs already received (deduplication). */
  webhookEvents: { id: string; at: string };
  /** Token import runs by file hash: the attempt number is part of the idempotency key. */
  imports: { id: string; attempt: number };
}
export type Kind = keyof Docs;

/** Document-style storage: one row per object, JSON payload. */
export interface Store {
  list<K extends Kind>(kind: K): Promise<Docs[K][]>;
  put<K extends Kind>(kind: K, id: string, doc: Docs[K]): Promise<void>;
  remove(kind: Kind, id: string): Promise<void>;
  /** Insert only if absent; false when the ID was already stored. */
  claim<K extends Kind>(kind: K, id: string, doc: Docs[K]): Promise<boolean>;
  clear(): Promise<void>;
}

export class MemoryStore implements Store {
  private data = new Map<string, Map<string, unknown>>();
  private t(kind: string) {
    let m = this.data.get(kind);
    if (!m) this.data.set(kind, (m = new Map()));
    return m;
  }
  async list<K extends Kind>(kind: K) {
    return [...this.t(kind).values()] as Docs[K][];
  }
  async put<K extends Kind>(kind: K, id: string, doc: Docs[K]) {
    this.t(kind).set(id, structuredClone(doc));
  }
  async remove(kind: Kind, id: string) {
    this.t(kind).delete(id);
  }
  async claim<K extends Kind>(kind: K, id: string, doc: Docs[K]) {
    if (this.t(kind).has(id)) return false;
    this.t(kind).set(id, structuredClone(doc));
    return true;
  }
  async clear() {
    this.data.clear();
  }
}

const DDL =
  "CREATE TABLE IF NOT EXISTS docs (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (kind, id))";

export class SqliteStore implements Store {
  private db;
  constructor(db: import("node:sqlite").DatabaseSync) {
    this.db = db;
    db.exec(DDL);
  }
  async list<K extends Kind>(kind: K) {
    const rows = this.db
      .prepare("SELECT data FROM docs WHERE kind = ?")
      .all(kind) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Docs[K]);
  }
  async put<K extends Kind>(kind: K, id: string, doc: Docs[K]) {
    this.db
      .prepare(
        "INSERT INTO docs (kind, id, data) VALUES (?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET data = excluded.data",
      )
      .run(kind, id, JSON.stringify(doc));
  }
  async remove(kind: Kind, id: string) {
    this.db.prepare("DELETE FROM docs WHERE kind = ? AND id = ?").run(kind, id);
  }
  async claim<K extends Kind>(kind: K, id: string, doc: Docs[K]) {
    const r = this.db
      .prepare(
        "INSERT INTO docs (kind, id, data) VALUES (?, ?, ?) ON CONFLICT (kind, id) DO NOTHING",
      )
      .run(kind, id, JSON.stringify(doc));
    return Number(r.changes) === 1;
  }
  async clear() {
    this.db.exec("DELETE FROM docs");
  }
}

export class PgStore implements Store {
  private ready: Promise<unknown>;
  constructor(private pool: import("pg").Pool) {
    this.ready = pool.query(DDL);
  }
  async list<K extends Kind>(kind: K) {
    await this.ready;
    const r = await this.pool.query("SELECT data FROM docs WHERE kind = $1", [
      kind,
    ]);
    return r.rows.map((x) => JSON.parse(x.data) as Docs[K]);
  }
  async put<K extends Kind>(kind: K, id: string, doc: Docs[K]) {
    await this.ready;
    await this.pool.query(
      "INSERT INTO docs (kind, id, data) VALUES ($1, $2, $3) ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data",
      [kind, id, JSON.stringify(doc)],
    );
  }
  async remove(kind: Kind, id: string) {
    await this.ready;
    await this.pool.query("DELETE FROM docs WHERE kind = $1 AND id = $2", [
      kind,
      id,
    ]);
  }
  async claim<K extends Kind>(kind: K, id: string, doc: Docs[K]) {
    await this.ready;
    const r = await this.pool.query(
      "INSERT INTO docs (kind, id, data) VALUES ($1, $2, $3) ON CONFLICT (kind, id) DO NOTHING",
      [kind, id, JSON.stringify(doc)],
    );
    return r.rowCount === 1;
  }
  async clear() {
    await this.ready;
    await this.pool.query("DELETE FROM docs");
  }
}

export async function createStore(demo: boolean): Promise<Store> {
  if (demo) return new MemoryStore();
  if (config.databaseUrl) {
    const { Pool } = await import("pg");
    return new PgStore(new Pool({ connectionString: config.databaseUrl }));
  }
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(config.sqlitePath), { recursive: true });
  return new SqliteStore(new DatabaseSync(config.sqlitePath));
}

export type { Settings };
