// 2026-11-23: a due date of "1" returned a 500. The API accepted anything `Date.parse` could read,
// then Postgres refused it. Other values were saved wrongly: "1/2/2026" became 2 January, and a time
// with no zone was stored as UTC. The API now takes only an ISO date and time with a zone.
import { describe, expect, test } from "vitest";
import { authAs, makeTestApp } from "../helpers.js";

async function post(body: unknown) {
  const { app } = await makeTestApp();
  return app.request("/api/items", {
    method: "POST",
    headers: await authAs("alice"),
    body: JSON.stringify(body),
  });
}

describe("due dates", () => {
  test.each([
    "1",
    "Item 5",
    "March 7",
    "1/2/2026",
    "2026-11-20",
    "2026-03-01T09:00",
    "2026-02-30T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "0000-01-01T00:00:00Z",
    "0001-01-01T00:00:00Z",
    "0999-12-31T23:59:59Z",
    "1000-01-01T00:00:00+14:00",
    "9999-12-31T23:59:59-14:00",
    "2026-11-20T07:30:00Z\u0000",
  ])("%j is refused as a bad request", async (dueAt) => {
    const res = await post({ title: "Return keys", dueAt });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: string[] }).fields).toEqual(["dueAt"]);
  });

  test.each([
    "2026-11-20T07:30:00Z",
    "2026-11-20T07:30:00.123Z",
    "2026-11-20T17:30:00+10:00",
    "2028-02-29T00:00:00Z",
    "1000-01-01T00:00:00Z",
    "9999-12-31T23:59:59Z",
  ])("%j is saved as that exact moment", async (dueAt) => {
    const res = await post({ title: "Return keys", dueAt });
    expect(res.status).toBe(201);
    const { item } = (await res.json()) as { item: { dueAt: string } };
    expect(new Date(item.dueAt).getTime()).toBe(new Date(dueAt).getTime());
  });
});

test("a title holding a NUL character is refused, because Postgres can't store it", async () => {
  const res = await post({ title: "Return\u0000keys" });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { fields: string[] }).fields).toEqual(["title"]);
});
