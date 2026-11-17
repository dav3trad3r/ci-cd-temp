import { readdir, readFile } from "node:fs/promises";
import type { Pool } from "pg";

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

/** Applies any .sql files in db/migrations that have not run yet, in name order. */
export async function applyMigrations(db: Db, dir: URL = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(`
    create table if not exists _migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    );
    alter table _migrations enable row level security;
  `);
  const done = new Set(
    (await db.query<{ name: string }>("select name from _migrations")).rows.map((r) => r.name),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    await db.exec(await readFile(new URL(file, dir), "utf8"));
    await db.query("insert into _migrations (name) values ($1)", [file]);
    applied.push(file);
  }
  return applied;
}
