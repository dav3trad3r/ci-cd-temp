// API contract snapshots: these fail if a response's shape changes (a renamed field, a
// new error format), so an accidental change to what other tools rely on shows up in
// review. Values that change on every run (ids, timestamps) are matched by type only.
// If a change is intended, run `npx vitest run -u` and commit the updated snapshot.
import { expect, test } from "vitest";
import { authAs, makeTestApp } from "../helpers.js";

const anyItem = {
  id: expect.any(String),
  createdAt: expect.any(String),
};

test("item responses keep their shape", async () => {
  const { app } = await makeTestApp();
  const headers = await authAs("alice");

  const created = await app.request("/api/items", {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Chase signed lease", dueAt: "2026-11-23T00:00:00Z" }),
  });
  expect(created.status).toBe(201);
  const { item } = (await created.json()) as { item: Record<string, unknown> };
  expect(item).toMatchSnapshot(anyItem);

  const list = (await (await app.request("/api/items", { headers })).json()) as {
    items: Record<string, unknown>[];
  };
  expect(Object.keys(list)).toEqual(["items"]);
  expect(list.items[0]).toMatchSnapshot(anyItem);
});

test("error responses keep their shape", async () => {
  const { app } = await makeTestApp();

  const unauthorised = await app.request("/api/items");
  expect({ status: unauthorised.status, body: await unauthorised.json() }).toMatchSnapshot();

  const invalid = await app.request("/api/items", {
    method: "POST",
    headers: await authAs("alice"),
    body: JSON.stringify({ title: "" }),
  });
  expect({ status: invalid.status, body: await invalid.json() }).toMatchSnapshot();

  const missing = await app.request("/api/items/00000000-0000-4000-8000-000000000000", {
    headers: await authAs("alice"),
  });
  expect({ status: missing.status, body: await missing.json() }).toMatchSnapshot();
});
