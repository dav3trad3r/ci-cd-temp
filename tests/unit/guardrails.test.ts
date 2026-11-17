import { describe, expect, test } from "vitest";
import {
  type ChangeSet,
  findWeakenedChecks,
  parseAddedLines,
  parseNameStatus,
} from "../../scripts/guardrails.js";

// Builds a change from file contents before and after.
function change(
  parts: Partial<ChangeSet> & {
    before?: Record<string, string>;
    after?: Record<string, string>;
  },
): ChangeSet {
  const before = parts.before ?? {};
  const after = parts.after ?? before;
  return {
    files: parts.files ?? [],
    addedLines: parts.addedLines ?? [],
    readBase: (p) => before[p],
    readHead: (p) => after[p],
    author: parts.author,
  };
}

const rules = (c: ChangeSet) => findWeakenedChecks(c).map((f) => f.rule);

describe("guardrails", () => {
  test("an ordinary change passes", () => {
    expect(
      rules(
        change({
          files: [{ status: "M", path: "src/server/app.ts" }],
          addedLines: [{ path: "src/server/app.ts", line: "  return c.json({ ok: true });" }],
        }),
      ),
    ).toEqual([]);
  });

  test("flags a skipped or focused test", () => {
    for (const line of [
      '  it.skip("works", () => {',
      'test.only("x", () => {',
      'xit("y", () => {',
    ]) {
      expect(rules(change({ addedLines: [{ path: "tests/unit/x.test.ts", line }] }))).toEqual([
        "test skipped",
      ]);
    }
  });

  test("flags a silenced linter or type checker", () => {
    for (const line of ["// eslint-disable-next-line", "// @ts-ignore", "// @ts-nocheck"]) {
      expect(rules(change({ addedLines: [{ path: "src/lib/db.ts", line }] }))).toEqual([
        "check silenced",
      ]);
    }
  });

  test("flags a deleted security or regression test, but not a move within the folder", () => {
    expect(
      rules(change({ files: [{ status: "D", path: "tests/security/access.test.ts" }] })),
    ).toEqual(["protected test removed"]);
    expect(
      rules(
        change({
          files: [
            { status: "R100", path: "tests/old.test.ts", oldPath: "tests/regressions/a.test.ts" },
          ],
        }),
      ),
    ).toEqual(["protected test removed"]);
    expect(
      rules(
        change({
          files: [
            {
              status: "R100",
              path: "tests/regressions/b.test.ts",
              oldPath: "tests/regressions/a.test.ts",
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  test("flags a raised budget, but not a tighter one", () => {
    const before = { "budgets.json": '{ "webJsKbGzip": 25 }' };
    expect(rules(change({ before, after: { "budgets.json": '{ "webJsKbGzip": 40 }' } }))).toEqual([
      "budget raised",
    ]);
    expect(rules(change({ before, after: { "budgets.json": '{ "webJsKbGzip": 20 }' } }))).toEqual(
      [],
    );
  });

  test("flags a lowered or removed AI baseline, but not a higher one", () => {
    const before = { "evals/baseline.json": '{ "minAccuracy": 0.9 }' };
    const after = (json: string) => ({ "evals/baseline.json": json });
    expect(rules(change({ before, after: after('{ "minAccuracy": 0.5 }') }))).toEqual([
      "baseline lowered",
    ]);
    expect(rules(change({ before, after: after("{}") }))).toEqual(["baseline lowered"]);
    expect(rules(change({ before, after: after('{ "minAccuracy": 0.95 }') }))).toEqual([]);
  });

  test("flags a changed check script in package.json", () => {
    const pkg = (test: string) => JSON.stringify({ scripts: { test, dev: "tsx watch" } });
    expect(
      rules(
        change({
          before: { "package.json": pkg("vitest run") },
          after: { "package.json": pkg("vitest run --passWithNoTests") },
        }),
      ),
    ).toEqual(["check script changed"]);
  });

  test("flags edits to workflows and agent settings, except Dependabot bumping actions", () => {
    const files = [{ status: "M", path: ".github/workflows/ci.yml" }];
    expect(rules(change({ files }))).toEqual(["guarded file changed"]);
    expect(rules(change({ files, author: "dependabot[bot]" }))).toEqual([]);
    expect(rules(change({ files: [{ status: "A", path: ".claude/settings.json" }] }))).toEqual([
      "guarded file changed",
    ]);
  });
});

describe("git output parsing", () => {
  test("reads name-status lines, including renames", () => {
    expect(parseNameStatus("M\tsrc/a.ts\nR090\told.ts\tnew.ts\n")).toEqual([
      { status: "M", path: "src/a.ts" },
      { status: "R090", path: "new.ts", oldPath: "old.ts" },
    ]);
  });

  test("reads only added lines, with their file", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "-removed",
    ].join("\n");
    expect(parseAddedLines(diff)).toEqual([{ path: "src/a.ts", line: "new" }]);
  });
});
