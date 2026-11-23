// 2026-11-23: Guardrails only knew this template's layout, so a migrated tool could weaken its
// checks unnoticed: `test:unit` changed to `echo ok`, `it.skip` in a `.spec.ts` file, an edited
// `eslint.config.mjs`, or a workflow edit on a Dependabot pull request. The rules now go by what a
// file is rather than where this template keeps it.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  findWeakenedChecks,
  parseAddedLines,
  parseNameStatus,
  type ChangedFile,
  type ChangeSet,
} from "../../scripts/guardrails.js";

function change(parts: {
  files?: ChangedFile[];
  lines?: [string, string][];
  before?: Record<string, string>;
  after?: Record<string, string>;
  author?: string;
}): ChangeSet {
  const before = parts.before ?? {};
  const after = parts.after ?? before;
  return {
    files: parts.files ?? [],
    addedLines: (parts.lines ?? []).map(([path, line]) => ({ path, line })),
    readBase: (path) => before[path],
    readHead: (path) => after[path],
    author: parts.author,
  };
}
const rules = (c: ChangeSet) => findWeakenedChecks(c).map((f) => f.rule);
const pkg = (scripts: Record<string, string>, extra: object = {}) =>
  JSON.stringify({ scripts, ...extra });

describe("scripts that run checks", () => {
  test.each([
    ["test:unit", "vitest run"],
    ["test:ci", "jest --ci"],
    ["type-check", "tsc --noEmit"],
    ["check-types", "tsc --noEmit"],
    ["fmt:check", "prettier --check ."],
    ["pretest", "npm run build"],
  ])("%s changed to `echo ok` is caught", (name, command) => {
    const c = change({
      files: [{ status: "M", path: "package.json" }],
      before: { "package.json": pkg({ [name]: command }) },
      after: { "package.json": pkg({ [name]: "echo ok" }) },
    });
    expect(rules(c)).toContain("check script changed");
  });

  test("a script the manifest names is caught, whatever it's called", () => {
    const manifest = JSON.stringify({ commands: { test: "npm run qa" } });
    const c = change({
      files: [{ status: "M", path: "package.json" }],
      before: { "package.json": pkg({ qa: "vitest run" }), ".platform/tool.json": manifest },
      after: { "package.json": pkg({ qa: "echo ok" }), ".platform/tool.json": manifest },
    });
    expect(rules(c)).toEqual(["check script changed"]);
  });

  test("a script that a check calls is caught", () => {
    const c = change({
      files: [{ status: "M", path: "package.json" }],
      before: { "package.json": pkg({ test: "npm run suite", suite: "vitest run" }) },
      after: { "package.json": pkg({ test: "npm run suite", suite: "echo ok" }) },
    });
    expect(rules(c)).toEqual(["check script changed"]);
  });

  test("a package in a subfolder is covered", () => {
    const path = "services/api/package.json";
    const c = change({
      files: [{ status: "M", path }],
      before: { [path]: pkg({ test: "vitest run" }) },
      after: { [path]: pkg({ test: "echo ok" }) },
    });
    expect(rules(c)).toEqual(["check script changed"]);
  });

  test("a jest block in package.json is caught", () => {
    const c = change({
      files: [{ status: "M", path: "package.json" }],
      before: { "package.json": pkg({}, { jest: { testMatch: ["**/*.test.js"] } }) },
      after: { "package.json": pkg({}, { jest: { testMatch: ["**/nothing.js"] } }) },
    });
    expect(rules(c)).toEqual(["check settings changed"]);
  });

  test("an ordinary script can still change", () => {
    const c = change({
      files: [{ status: "M", path: "package.json" }],
      before: { "package.json": pkg({ dev: "vite", test: "vitest run" }) },
      after: { "package.json": pkg({ dev: "vite --host", test: "vitest run" }) },
    });
    expect(rules(c)).toEqual([]);
  });
});

describe("check settings, wherever they live", () => {
  test.each([
    "eslint.config.mjs",
    "eslint.config.ts",
    ".eslintrc.json",
    ".eslintrc",
    ".eslintignore",
    "biome.json",
    "vitest.config.mts",
    "vite.config.ts",
    "jest.config.js",
    "playwright.config.ts",
    "tsconfig.app.json",
    "packages/web/tsconfig.json",
    "prettier.config.js",
    ".prettierrc.yaml",
    ".github/dependabot.yml",
    ".gitleaks.toml",
    ".gitattributes",
    "services/api/.platform/tool.json",
    "services/api/eslint.config.js",
  ])("%s", (path) => {
    expect(rules(change({ files: [{ status: "M", path }] }))).toEqual(["guarded file changed"]);
  });
});

describe("skipped tests", () => {
  test.each([
    ["src/app.spec.ts", '  it.skip("works", () => {'],
    ["test/foo.js", 'it.skip("works", () => {'],
    ["__tests__/foo.js", 'test.only("works", () => {'],
    ["src/app.test.ts", 'it.concurrent.skip("works", () => {'],
    ["src/app.test.ts", 'it.fails("works", () => {'],
    ["src/app.test.ts", 'it.runIf(false)("works", () => {'],
    ["src/app.spec.tsx", 'fit("works", () => {'],
    ["src/app.spec.ts", 'fdescribe("works", () => {'],
    ["src/app.test.ts", "  .skip('works', () => {"],
    ["e2e/login.ts", "test . skip('works', () => {"],
    ["src/app.spec.ts", "  this.skip();"],
  ])("%s: %s", (path, line) => {
    expect(rules(change({ lines: [[path, line]] }))).toContain("test skipped");
  });

  test("an assertion replaced with one that can't fail is caught", () => {
    const c = change({ lines: [["src/app.spec.ts", "  expect(true).toBe(true);"]] });
    expect(rules(c)).toEqual(["assertion weakened"]);
  });

  test("a test file that asserts less than before is caught", () => {
    const path = "src/app.spec.ts";
    const c = change({
      files: [{ status: "M", path }],
      before: { [path]: "expect(a).toBe(1); expect(b).toBe(2);" },
      after: { [path]: "expect(a).toBe(1);" },
    });
    expect(rules(c)).toEqual(["assertion weakened"]);
  });

  test("a test file that asserts more is fine", () => {
    const path = "src/app.spec.ts";
    const c = change({
      files: [{ status: "M", path }],
      lines: [[path, "expect(b).toBe(2);"]],
      before: { [path]: "expect(a).toBe(1);" },
      after: { [path]: "expect(a).toBe(1); expect(b).toBe(2);" },
    });
    expect(rules(c)).toEqual([]);
  });

  test("ordinary code using the same words is fine", () => {
    const c = change({ lines: [["src/list.ts", "const page = query.skip(10).limit(5);"]] });
    expect(rules(c)).toEqual([]);
  });
});

describe("silenced checks", () => {
  test.each([
    ["src/a.ts", "// @ts-expect-error"],
    ["src/App.vue", "<!-- eslint-disable -->"],
    ["src/a.ts", "// biome-ignore lint: later"],
    ["src/a.ts", "/* c8 ignore next */"],
    ["config/keys.yml", "key: abc # gitleaks:allow"],
  ])("%s: %s", (path, line) => {
    expect(rules(change({ lines: [[path, line]] }))).toEqual(["check silenced"]);
  });
});

describe("removed tests", () => {
  test.each([
    { status: "D", path: "src/app.spec.ts" },
    { status: "D", path: "test/security/access.test.js" },
    { status: "R100", path: "src/app.spec.ts.bak", oldPath: "src/app.spec.ts" },
    {
      status: "R100",
      path: "src/archive/access.test.ts",
      oldPath: "tests/security/access.test.ts",
    },
  ])("$status $path", (file) => {
    expect(rules(change({ files: [file] }))).toContain("protected test removed");
  });

  test("a test moved to another test folder is fine", () => {
    const file = { status: "R100", path: "tests/unit/a.test.ts", oldPath: "tests/a.test.ts" };
    expect(rules(change({ files: [file] }))).toEqual([]);
  });

  test("deleting the baseline is caught", () => {
    const file = { status: "D", path: ".platform/baseline.json" };
    expect(rules(change({ files: [file] }))).toEqual(["baseline raised"]);
  });
});

describe("Dependabot", () => {
  const path = ".github/workflows/platform.yml";
  const workflow = (ref: string, extra = "") =>
    `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${ref} # v7\n${extra}`;
  const dependabot = (after?: string, status = "M") =>
    rules(
      change({
        author: "dependabot[bot]",
        files: [{ status, path }],
        before: { [path]: workflow("aaa") },
        after: after === undefined ? {} : { [path]: after },
      }),
    );

  test("may move an action's version", () => {
    expect(dependabot(workflow("bbb"))).toEqual([]);
  });

  test("may not change anything else in a workflow", () => {
    expect(dependabot(workflow("bbb", "      - run: echo skipped\n"))).toEqual([
      "guarded file changed",
    ]);
  });

  test("may not swap one action for another", () => {
    const swapped = workflow("bbb").replace("actions/checkout", "someone/checkout");
    expect(dependabot(swapped)).toEqual(["guarded file changed"]);
  });

  test("may not delete a workflow", () => {
    expect(dependabot(undefined, "D")).toEqual(["guarded file changed"]);
  });
});

describe("reading git's output", () => {
  test("an added line that looks like a file header can't hide what follows", () => {
    const diff = [
      "diff --git a/src/a.spec.ts b/src/a.spec.ts",
      "--- a/src/a.spec.ts",
      "+++ b/src/a.spec.ts",
      "@@ -0,0 +1,2 @@",
      "+++ b/README.md",
      '+it.skip("hidden", () => {});',
    ].join("\n");
    expect(parseAddedLines(diff)).toEqual([
      { path: "src/a.spec.ts", line: "++ b/README.md" },
      { path: "src/a.spec.ts", line: 'it.skip("hidden", () => {});' },
    ]);
  });

  test("a quoted, non-English file name is read correctly", () => {
    const diff = [
      '+++ "b/src/caf\\303\\251.spec.ts"',
      "@@ -0,0 +1 @@",
      '+it.skip("x", () => {});',
    ].join("\n");
    expect(parseAddedLines(diff)[0]?.path).toBe("src/café.spec.ts");
  });

  test("names with -z are read exactly", () => {
    expect(parseNameStatus("M\0src/a b.ts\0R100\0old\tname.ts\0new.ts\0")).toEqual([
      { status: "M", path: "src/a b.ts" },
      { status: "R100", oldPath: "old\tname.ts", path: "new.ts" },
    ]);
  });

  test("real git output, including a file marked as binary", () => {
    const dir = mkdtempSync(join(tmpdir(), "guardrails-git-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        cwd: dir,
        encoding: "utf8",
      });
    try {
      git("init", "-q");
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, ".gitattributes"), "*.spec.ts -diff\n");
      writeFileSync(join(dir, "src", "café.spec.ts"), "export {};\n");
      git("add", "-A");
      git("commit", "-q", "-m", "one");
      writeFileSync(join(dir, "src", "café.spec.ts"), 'it.skip("x", () => {});\n');
      git("add", "-A");
      git("commit", "-q", "-m", "two");
      const output = git(
        "-c",
        "core.quotePath=false",
        "diff",
        "--unified=0",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--text",
        "HEAD~1..HEAD",
      );
      expect(parseAddedLines(output)).toContainEqual({
        path: "src/café.spec.ts",
        line: 'it.skip("x", () => {});',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
