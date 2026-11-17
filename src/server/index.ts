import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { applyMigrations, fromPg, inMemoryDb } from "../lib/db.js";
import { createApp } from "./app.js";

const production = process.env.NODE_ENV === "production";

// Safe defaults: production refuses to start without real settings, while local runs
// get a random secret and an in-process database so `npm run dev` needs no set-up.
const jwtSecret =
  process.env.APP_JWT_SECRET ?? (production ? undefined : randomBytes(32).toString("hex"));
if (!jwtSecret) {
  console.error("APP_JWT_SECRET is not set. Refusing to start in production without it.");
  process.exit(1);
}
if (production && !process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Refusing to start in production without it.");
  process.exit(1);
}

const db = process.env.DATABASE_URL
  ? fromPg(new pg.Pool({ connectionString: process.env.DATABASE_URL }))
  : await inMemoryDb();
if (!process.env.DATABASE_URL) {
  console.warn("No DATABASE_URL: using a temporary in-memory database. Data is lost on restart.");
}

const applied = await applyMigrations(db);
if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);

const app = createApp({
  db,
  jwtSecret,
  timeZone: process.env.BUSINESS_TIME_ZONE ?? "Australia/Brisbane",
});
app.use("/*", serveStatic({ root: "./dist/web" }));

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Listening on http://localhost:${info.port}`);
});
