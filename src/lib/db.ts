import { readdir, readFile } from "node:fs/promises";
import pg, { type Pool } from "pg";

/** The small slice of a Postgres client the app uses, so tests can swap in PGlite. */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs one or more statements with no parameters (used for migrations). */
  exec(sql: string): Promise<void>;
}

export function fromPg(pool: Pool): Db {
  return {
    query: async <T>(sql: string, params?: unknown[]) => {
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[] };
    },
    exec: async (sql) => {
      await pool.query(sql);
    },
  };
}

/** One connection. Migrations need it, because a transaction can't span a pool. */
function fromClient(client: pg.Client): Db {
  return {
    query: async <T>(sql: string, params?: unknown[]) => {
      const result = await client.query(sql, params);
      return { rows: result.rows as T[] };
    },
    exec: async (sql) => {
      await client.query(sql);
    },
  };
}

/** A throwaway in-process Postgres (PGlite) for tests and local development. */
export async function inMemoryDb(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite();
  return {
    query: async <T>(sql: string, params?: unknown[]) => {
      const result = await pg.query<T>(sql, params);
      return { rows: result.rows };
    },
    exec: async (sql) => {
      await pg.exec(sql);
    },
  };
}

export const MIGRATIONS_DIR = new URL("../../db/migrations/", import.meta.url);

// Any fixed number. It names the lock that stops two runners migrating at once.
const MIGRATION_LOCK = 727001;

/** Runs the work in one transaction, holding the migration lock until it ends. */
async function locked<T>(db: Db, work: () => Promise<T>): Promise<T> {
  await db.exec("begin");
  try {
    await db.query(`select pg_advisory_xact_lock(${MIGRATION_LOCK})`);
    const result = await work();
    await db.exec("commit");
    return result;
  } catch (error) {
    await db.exec("rollback").catch(() => undefined);
    throw error;
  }
}

const migrationFiles = async (dir: URL) =>
  (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

/**
 * Applies any .sql files in db/migrations that have not run yet, in name order. Each file runs in
 * its own transaction, so it must not contain its own begin or commit. Pass a single connection:
 * use migrateDatabase for a real database.
 */
export async function applyMigrations(db: Db, dir: URL = MIGRATIONS_DIR): Promise<string[]> {
  await locked(db, () =>
    db.exec(`
      create table if not exists _migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      );
      alter table _migrations enable row level security;
    `),
  );
  const applied: string[] = [];
  for (const file of await migrationFiles(dir)) {
    const ran = await locked(db, async () => {
      const { rows } = await db.query("select 1 from _migrations where name = $1", [file]);
      if (rows.length) return false;
      await db.exec(await readFile(new URL(file, dir), "utf8"));
      await db.query("insert into _migrations (name) values ($1)", [file]);
      return true;
    });
    if (ran) applied.push(file);
  }
  return applied;
}

/** Applies migrations to a real database, on one connection of its own. */
export async function migrateDatabase(connectionString: string): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await applyMigrations(fromClient(client));
  } finally {
    await client.end();
  }
}

/** The migrations this database hasn't had yet. Reads only. */
export async function pendingMigrations(db: Db, dir: URL = MIGRATIONS_DIR): Promise<string[]> {
  const files = await migrationFiles(dir);
  const { rows } = await db.query<{ found: string | null }>(
    "select to_regclass('public._migrations')::text as found",
  );
  if (!rows[0]?.found) return files;
  const done = new Set(
    (await db.query<{ name: string }>("select name from _migrations")).rows.map((r) => r.name),
  );
  return files.filter((f) => !done.has(f));
}

/**
 * What the server does to its database when it starts. A deployed revision may only be on staging
 * and it shares the production database, so it changes nothing: the release step migrates after
 * approval. A local run sets up its own database.
 */
export async function onBoot(
  db: Db,
  production: boolean,
  migrate: () => Promise<string[]> = () => applyMigrations(db),
): Promise<{ applied: string[]; waiting: string[] }> {
  if (production) return { applied: [], waiting: await pendingMigrations(db) };
  return { applied: await migrate(), waiting: [] };
}
