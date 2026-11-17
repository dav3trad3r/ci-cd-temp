// The number one mistake in AI-written APIs is a route that works without signing in,
// or that lets one user read another's records. These tests must keep passing for
// every protected route you add: copy one and point it at the new route.
import { describe, expect, test } from "vitest";
import { authAs, makeTestApp } from "../helpers.js";

describe("access control", () => {
  test("every API route refuses a request with no sign-in", async () => {
    const { app } = await makeTestApp();
    const anonymous = [
      app.request("/api/items"),
      app.request("/api/items", { method: "POST", body: JSON.stringify({ title: "x" }) }),
      app.request("/api/items/00000000-0000-4000-8000-000000000000"),
    ];
    for (const res of await Promise.all(anonymous)) {
      expect(res.status).toBe(401);
    }
  });

  test("a forged or malformed token is refused", async () => {
    const { app } = await makeTestApp();
    const res = await app.request("/api/items", {
      headers: { authorization: "Bearer not.a.real-token" },
    });
    expect(res.status).toBe(401);
  });

  test("a user cannot read another user's item, and cannot tell it exists", async () => {
    const { app } = await makeTestApp();
    const created = await app.request("/api/items", {
      method: "POST",
      headers: await authAs("alice"),
      body: JSON.stringify({ title: "Alice's private note" }),
    });
    const { item } = (await created.json()) as { item: { id: string } };

    const asBob = await app.request(`/api/items/${item.id}`, { headers: await authAs("bob") });
    expect(asBob.status).toBe(404);

    const bobsList = await app.request("/api/items", { headers: await authAs("bob") });
    expect(((await bobsList.json()) as { items: unknown[] }).items).toHaveLength(0);

    const asAlice = await app.request(`/api/items/${item.id}`, { headers: await authAs("alice") });
    expect(asAlice.status).toBe(200);
  });

  test("the health check stays public", async () => {
    const { app } = await makeTestApp();
    expect((await app.request("/healthz")).status).toBe(200);
  });
});
