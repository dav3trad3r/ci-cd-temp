// Regression: GET /api/items/due-soon returned 500 for every request after it shipped on
// 2026-11-22 (incident INC-DEMO-1042). Staff opening the due-soon list saw an error. The
// query sorted by a column called due_date, but the column is due_at, so Postgres
// refused it ("column \"due_date\" does not exist"). The route had no test, so nothing
// ran the query before it reached production. Fixed 2026-11-22 by sorting on due_at.
import { expect, test } from "vitest";
import { authAs, makeTestApp } from "../helpers.js";

const DAY = 24 * 60 * 60 * 1000;

test("due-soon answers 200 with the next 7 days' items, soonest first", async () => {
  const { app } = await makeTestApp();
  const headers = await authAs("alice");
  const now = Date.now();
  const add = (title: string, dueAt?: number) =>
    app.request("/api/items", {
      method: "POST",
      headers,
      body: JSON.stringify(
        dueAt === undefined ? { title } : { title, dueAt: new Date(dueAt).toISOString() },
      ),
    });
  await add("In three days", now + 3 * DAY);
  await add("Tomorrow", now + 1 * DAY);
  await add("In ten days", now + 10 * DAY);
  await add("Yesterday", now - 1 * DAY);
  await add("No due date");

  const res = await app.request("/api/items/due-soon", { headers });
  expect(res.status).toBe(200);
  const { items } = (await res.json()) as { items: { title: string }[] };
  expect(items.map((i) => i.title)).toEqual(["Tomorrow", "In three days"]);
});
