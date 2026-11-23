// 2026-11-23: the baseline could let a broken tool deploy. A migrated tool with known test failures
// still counted as deployable after its test runner crashed, because a result that couldn't be
// counted was treated as the same old problem. If its build output moved, the browser-secret check
// was skipped, and a skip cleared even a serious problem. Moved SQL wasn't scanned at all.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  baselineLoosened,
  countProblems,
  evaluate,
  hasFailed,
  isReady,
  makeBaseline,
  type Baseline,
  type RawResult,
} from "../../scripts/platform/baseline.js";
import { manifestSchema, type Manifest } from "../../scripts/platform/model.js";
import { collectResults } from "../../scripts/platform/run-checks.js";

const failing = (name: RawResult["name"], output = "", extra: Partial<RawResult> = {}) =>
  ({ name, configured: true, ok: false, output, ...extra }) as RawResult;

const baseline = (checks: Baseline["checks"]): Baseline => ({
  version: 1,
  created: "2026-11-23",
  checks,
});
const threeFailing = baseline({ test: { status: "failing", problems: 3 } });

describe("a check that crashed isn't the same old problem", () => {
  test.each([
    "Error: Cannot find module 'vitest/config'",
    "Segmentation fault",
    "sh: 1: vitest: not found",
    "",
  ])("output with nothing to count fails a counted baseline: %j", (output) => {
    const result = evaluate(failing("test", output), threeFailing);
    expect(result.status).toBe("fail");
    expect(isReady([result])).toBe(false);
  });

  test("the same known failures still don't block anyone", () => {
    const result = evaluate(failing("test", "Tests  3 failed | 9 passed (12)"), threeFailing);
    expect(result.status).toBe("known");
    expect(isReady([result])).toBe(true);
  });

  test("a killed process fails, even when its count looks fine", () => {
    const result = evaluate(
      failing("test", "Tests  3 failed | 9 passed (12)", { crashed: true }),
      threeFailing,
    );
    expect(result.status).toBe("fail");
  });

  test("a killed process fails a baseline that had no count", () => {
    const known = baseline({ build: { status: "failing", problems: null } });
    expect(evaluate(failing("build", "", { crashed: true }), known).status).toBe("fail");
    expect(evaluate(failing("build", "error"), known).status).toBe("known");
  });

  test("a tool that already crashed when it joined isn't blocked by that", () => {
    const first = failing("test", "sh: vitest: not found", { crashed: true });
    const known = makeBaseline([first], "2026-11-23");
    expect(known.checks.test).toEqual({ status: "failing", problems: null, crashed: true });
    expect(evaluate(first, known).status).toBe("known");
  });

  test("allowing a crash on the baseline counts as loosening it", () => {
    const before = baseline({ test: { status: "failing", problems: null } });
    const after = baseline({ test: { status: "failing", problems: null, crashed: true } });
    expect(baselineLoosened(before, after)).toHaveLength(1);
  });

  test.each([
    ["Vitest", "⎯⎯ Failed Suites 1 ⎯⎯\n Test Files  2 failed\n      Tests  3 failed | 9 passed", 4],
    ["Jest", "● Test suite failed to run\n\nTests:       3 failed, 9 passed, 12 total", 4],
    ["only a file that can't load", "⎯⎯ Failed Suites 2 ⎯⎯\n Test Files  2 failed", 2],
  ])("a test file that can't load counts as a new problem: %s", (_runner, output, count) => {
    expect(countProblems("test", output)).toBe(count);
    const oneFewer = baseline({ test: { status: "failing", problems: count - 1 } });
    expect(evaluate(failing("test", output), oneFewer).status).toBe("fail");
  });
});

describe("what blocks a deployment", () => {
  test("a skip never clears a serious problem", () => {
    const known = baseline({ frontend: { status: "failing", problems: 1, serious: true } });
    const result = evaluate(
      { name: "frontend", configured: true, ok: true, output: "", skipped: "no build to check" },
      known,
    );
    expect(result.status).toBe("known");
    expect(isReady([result])).toBe(false);
  });

  test.each(["install", "build"] as const)(
    "a known %s failure allows pull requests but not a deployment",
    (name) => {
      const known = baseline({ [name]: { status: "failing", problems: null } });
      const results = [evaluate(failing(name, "broken"), known)];
      expect(hasFailed(results)).toBe(false);
      expect(isReady(results)).toBe(false);
    },
  );
});

describe("checks follow the tool's files", () => {
  let dir: string;
  const manifest = (build: string): Manifest =>
    manifestSchema.parse({
      name: "notes-tool",
      kind: "migrated",
      owner: "sam@example.com",
      stack: "node",
      nodeVersion: "22",
      packageManager: "npm",
      commands: {
        install: null,
        format: null,
        lint: null,
        typecheck: null,
        test: null,
        build,
        smoke: null,
        eval: null,
      },
      webDir: "dist",
      start: null,
      port: 8080,
      healthPath: "/",
      dockerfile: null,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "baseline-tool-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const nodeRun = (code: string) => `node -e "${code}"`;

  test("a build that succeeds without its output fails the browser check", async () => {
    const [, frontend] = await collectResults({
      dir,
      manifest: manifest(nodeRun("process.exit(0)")),
      only: ["build", "frontend"],
    });
    expect(frontend?.name).toBe("frontend");
    expect(frontend?.ok).toBe(false);
    expect(frontend?.skipped).toBeUndefined();
    expect(evaluate(frontend as RawResult).status).toBe("fail");
  });

  test("a process that dies is reported as crashed", async () => {
    const [build] = await collectResults({
      dir,
      manifest: manifest(nodeRun("process.exit(137)")),
      only: ["build"],
    });
    expect(build?.crashed).toBe(true);
  });

  test("an ordinary failure isn't reported as a crash", async () => {
    const [build] = await collectResults({
      dir,
      manifest: manifest(nodeRun("process.exit(1)")),
      only: ["build"],
    });
    expect(build?.ok).toBe(false);
    expect(build?.crashed).toBeFalsy();
  });

  test("an open table is found wherever its SQL lives", async () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { "@supabase/supabase-js": "2.0.0" } }),
    );
    mkdirSync(join(dir, "database", "schema"), { recursive: true });
    writeFileSync(join(dir, "database", "schema", "t.sql"), "create table secrets_table (id int);");
    const [data] = await collectResults({ dir, manifest: manifest("x"), only: ["data"] });
    expect(data?.ok).toBe(false);
    expect(data?.output).toContain("secrets_table");
  });

  test("a secret-named REACT_APP_ variable is caught", async () => {
    writeFileSync(join(dir, ".env.example"), "REACT_APP_API_SECRET=replace-me\n");
    const [, frontend] = await collectResults({
      dir,
      manifest: manifest(
        nodeRun("require('fs').mkdirSync('dist');require('fs').writeFileSync('dist/a.js','1')"),
      ),
      only: ["build", "frontend"],
    });
    expect(frontend?.ok).toBe(false);
    expect(frontend?.output).toContain("REACT_APP_API_SECRET");
  });
});
