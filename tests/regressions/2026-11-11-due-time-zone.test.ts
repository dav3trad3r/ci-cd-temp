// Regression: due times were shown in the server's time zone (UTC on cloud hosts), so a
// 5:30 pm Brisbane deadline appeared as 7:30 am. Fixed 2026-11-11 by formatting every
// time people read in the business's own zone (src/lib/time.ts). This test pins it.
import { expect, test } from "vitest";
import { localDateTime } from "../../src/lib/time.js";
import { authAs, makeTestApp } from "../helpers.js";

test("formats an instant in the business's zone, not the server's", () => {
  const instant = "2026-11-20T07:30:00Z";
  expect(localDateTime(instant, "Australia/Brisbane")).toEqual({
    date: "2026-11-20",
    time: "17:30",
  });
  expect(localDateTime(instant, "Australia/Perth")).toEqual({ date: "2026-11-20", time: "15:30" });
  // Crossing midnight changes the date as well as the time.
  expect(localDateTime("2026-11-20T15:00:00Z", "Australia/Brisbane")).toEqual({
    date: "2026-11-21",
    time: "01:00",
  });
});

test("the API returns the local due time for the business's zone", async () => {
  const { app } = await makeTestApp("Australia/Brisbane");
  const res = await app.request("/api/items", {
    method: "POST",
    headers: await authAs("alice"),
    body: JSON.stringify({ title: "Return keys", dueAt: "2026-11-20T07:30:00Z" }),
  });
  const { item } = (await res.json()) as { item: { dueLocal: { date: string; time: string } } };
  expect(item.dueLocal).toEqual({ date: "2026-11-20", time: "17:30" });
});
