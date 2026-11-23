// Exposed data: the mistake AI-built tools make most often. A Supabase table in the public schema
// without row-level security can be read by anyone holding the public key, which every visitor's
// browser has. Pure, so the SQL rules are unit-tested.

export interface SqlFile {
  path: string;
  text: string;
}

const stripComments = (sql: string) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

/** "public"."Items" → public.items, and an unqualified name is in public. */
function tableName(raw: string): { schema: string; table: string } {
  const parts = raw
    .split(".")
    .map((p) => p.trim().replace(/^"|"$/g, "").toLowerCase())
    .filter(Boolean);
  return parts.length > 1
    ? { schema: parts[0] as string, table: parts[1] as string }
    : { schema: "public", table: parts[0] ?? "" };
}

const NAME = String.raw`((?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))?)`;

/** Read in order, so a table dropped or protected by a later migration isn't reported. */
export function findUnprotectedTables(files: SqlFile[]): string[] {
  const open = new Map<string, string>();
  const ordered = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const statement = new RegExp(
    String.raw`create\s+(?:(?:temp|temporary|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?${NAME}` +
      String.raw`|alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${NAME}\s+enable\s+row\s+level\s+security` +
      String.raw`|drop\s+table\s+(?:if\s+exists\s+)?${NAME}` +
      String.raw`|alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${NAME}\s+disable\s+row\s+level\s+security`,
    "gi",
  );

  for (const file of ordered) {
    for (const match of stripComments(file.text).matchAll(statement)) {
      const [whole, created, secured, dropped, unsecured] = match;
      const raw = created ?? secured ?? dropped ?? unsecured;
      if (!raw) continue;
      const { schema, table } = tableName(raw);
      if (schema !== "public") continue;
      if (created) {
        if (!/^create\s+temp(?:orary)?\s/i.test(whole)) open.set(table, file.path);
      } else if (secured || dropped) {
        open.delete(table);
      } else {
        open.set(table, file.path);
      }
    }
  }
  return [...open.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([table, path]) => `✗ ${path}: table "${table}" has no row-level security.`);
}

/** Only tools that talk to Supabase from the browser are exposed this way. */
export function usesSupabase(
  deps: Record<string, string> | undefined,
  topLevel: string[],
): boolean {
  return (
    topLevel.includes("supabase") ||
    Object.keys(deps ?? {}).some((d) => d === "@supabase/supabase-js" || d === "@supabase/ssr")
  );
}
