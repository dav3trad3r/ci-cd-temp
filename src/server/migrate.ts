// Updates the database: `npm run db:migrate`. On Azure this runs as the tool's one-off job, once
// a person has approved the release and before any traffic moves to it.
import { migrateDatabase } from "../lib/db.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set, so there's no database to update.");
  process.exit(1);
}

try {
  const applied = await migrateDatabase(url);
  console.log(
    applied.length ? `Applied migrations: ${applied.join(", ")}` : "No migrations to apply.",
  );
} catch (error) {
  console.error(`Migration failed: ${(error as Error).message}`);
  process.exit(1);
}
