// AI-built tools on Supabase often ship tables with row-level security switched off,
// which lets anyone holding the public key read them. This test applies every migration
// to a fresh database and fails if any table in the public schema is missing RLS.
import { expect, test } from "vitest";
import { applyMigrations, inMemoryDb } from "../../src/lib/db.js";

test("migrations apply cleanly to an empty database, and again with no changes", async () => {
  const db = await inMemoryDb();
  const first = await applyMigrations(db);
  expect(first.length).toBeGreaterThan(0);
  expect(await applyMigrations(db)).toEqual([]);
});

test("every table in the public schema has row-level security switched on", async () => {
  const db = await inMemoryDb();
  await applyMigrations(db);
  const { rows } = await db.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public' and rowsecurity = false order by tablename",
  );
  expect(
    rows.map((r) => r.tablename),
    "tables without row-level security",
  ).toEqual([]);
});
