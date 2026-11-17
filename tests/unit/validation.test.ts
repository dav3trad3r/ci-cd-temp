import { describe, expect, test } from "vitest";
import { classifyEnquiry } from "../../src/lib/classify.js";
import { authAs, makeTestApp } from "../helpers.js";

describe("creating items", () => {
  test("rejects a missing or blank title and says which field", async () => {
    const { app } = await makeTestApp();
    for (const body of [{}, { title: "   " }]) {
      const res = await app.request("/api/items", {
        method: "POST",
        headers: await authAs("alice"),
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { fields: string[] }).fields).toContain("title");
    }
  });

  test("rejects a due date that is not a date", async () => {
    const { app } = await makeTestApp();
    const res = await app.request("/api/items", {
      method: "POST",
      headers: await authAs("alice"),
      body: JSON.stringify({ title: "Book inspection", dueAt: "next Tuesdayish" }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects a body that is not JSON", async () => {
    const { app } = await makeTestApp();
    const res = await app.request("/api/items", {
      method: "POST",
      headers: await authAs("alice"),
      body: "title=hello",
    });
    expect(res.status).toBe(400);
  });
});

describe("classifyEnquiry", () => {
  test("sends a repair request to maintenance", () => {
    expect(classifyEnquiry("The hot water system is broken")).toBe("maintenance");
  });
});
