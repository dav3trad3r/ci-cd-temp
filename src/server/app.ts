import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "../lib/db.js";
import { localDateTime } from "../lib/time.js";
import { requireUser, type AuthEnv } from "./auth.js";

export interface AppOptions {
  db: Db;
  jwtSecret: string;
  /** The business's own time zone, used for dates people read. */
  timeZone: string;
}

const NewItem = z.object({
  title: z.string().trim().min(1).max(200),
  dueAt: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), "Use an ISO date and time")
    .optional(),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ItemRow {
  id: string;
  owner_id: string;
  title: string;
  due_at: Date | null;
  created_at: Date;
}

function toItem(row: ItemRow, timeZone: string) {
  const dueAt = row.due_at ? new Date(row.due_at).toISOString() : null;
  return {
    id: row.id,
    title: row.title,
    dueAt,
    dueLocal: dueAt ? localDateTime(dueAt, timeZone) : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export function createApp({ db, jwtSecret, timeZone }: AppOptions) {
  const app = new Hono<AuthEnv>();

  // Health check for the host (Railway, Azure Container Apps) and the smoke test.
  app.get("/healthz", (c) => c.json({ ok: true }));

  const api = new Hono<AuthEnv>();
  api.use("*", requireUser(jwtSecret));

  api.get("/items", async (c) => {
    const { rows } = await db.query<ItemRow>(
      "select id, owner_id, title, due_at, created_at from items where owner_id = $1 order by due_at nulls last, created_at, id",
      [c.get("userId")],
    );
    return c.json({ items: rows.map((r) => toItem(r, timeZone)) });
  });

  api.post("/items", async (c) => {
    const parsed = NewItem.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        {
          error: "invalid_item",
          message:
            "Give the item a title of 1 to 200 characters, and a valid due date if you set one.",
          fields: [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "body"))],
        },
        400,
      );
    }
    const { rows } = await db.query<ItemRow>(
      "insert into items (owner_id, title, due_at) values ($1, $2, $3) returning id, owner_id, title, due_at, created_at",
      [c.get("userId"), parsed.data.title, parsed.data.dueAt ?? null],
    );
    return c.json({ item: toItem(rows[0]!, timeZone) }, 201);
  });

  // Items due in the next 7 days, soonest first.
  api.get("/items/due-soon", async (c) => {
    const { rows } = await db.query<ItemRow>(
      "select id, owner_id, title, due_at, created_at from items where owner_id = $1 and due_at between now() and now() + interval '7 days' order by due_date",
      [c.get("userId")],
    );
    return c.json({ items: rows.map((r) => toItem(r, timeZone)) });
  });

  api.get("/items/:id", async (c) => {
    const id = c.req.param("id");
    // Someone else's item answers exactly like a missing one, so ids cannot be probed.
    const notFound = () => c.json({ error: "not_found", message: "No item with that id." }, 404);
    if (!UUID.test(id)) return notFound();
    const { rows } = await db.query<ItemRow>(
      "select id, owner_id, title, due_at, created_at from items where id = $1",
      [id],
    );
    const row = rows[0];
    if (!row || row.owner_id !== c.get("userId")) return notFound();
    return c.json({ item: toItem(row, timeZone) });
  });

  app.route("/api", api);
  return app;
}
