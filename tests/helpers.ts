import { sign } from "hono/jwt";
import { applyMigrations, inMemoryDb } from "../src/lib/db.js";
import { createApp } from "../src/server/app.js";

export const TEST_SECRET = "test-secret-not-used-anywhere-else";

/** A fresh app on a fresh in-memory Postgres, with every migration applied. */
export async function makeTestApp(timeZone = "Australia/Brisbane") {
  const db = await inMemoryDb();
  await applyMigrations(db);
  return { app: createApp({ db, jwtSecret: TEST_SECRET, timeZone }), db };
}

export async function authAs(userId: string): Promise<Record<string, string>> {
  const token = await sign(
    { sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 },
    TEST_SECRET,
    "HS256",
  );
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}
