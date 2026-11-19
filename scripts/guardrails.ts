// Guardrail rules: spot a change that weakens the checks instead of fixing the code.
//
// AI coding agents (and tired people) often "fix" a red build by skipping the failing
// test, raising a budget or silencing the linter. These rules find those changes in a
// pull request so a person has to approve them on purpose. The git plumbing lives in
// check-guardrails.ts; this file is pure so it can be unit tested.

export interface ChangedFile {
  /** git --name-status letter: A added, M modified, D deleted, R renamed, C copied. */
  status: string;
  path: string;
  /** The path before a rename or copy. */
  oldPath?: string;
}

export interface AddedLine {
  path: string;
  line: string;
}

export interface ChangeSet {
  files: ChangedFile[];
  addedLines: AddedLine[];
  /** File contents before the change (undefined if the file did not exist). */
  readBase: (path: string) => string | undefined;
  /** File contents after the change (undefined if the file was deleted). */
  readHead: (path: string) => string | undefined;
  /** Pull request author, used to let Dependabot bump pinned actions. */
  author?: string;
}

export interface Finding {
  rule: string;
  detail: string;
}

/** Files that decide what gets checked. Any change to them needs a person's approval. */
export const GUARDED_FILES = [
  ".github/workflows/",
  ".github/CODEOWNERS",
  ".claude/",
  "AGENTS.md",
  "CLAUDE.md",
  "vitest.config.ts",
  "eslint.config.js",
  "tsconfig.json",
  ".prettierrc.json",
  ".prettierignore",
  "bicepconfig.json",
  "scripts/check-frontend.mjs",
  "scripts/check-infra.mjs",
  "scripts/smoke.mjs",
  "evals/run.ts",
  "scripts/guardrails.ts",
  "scripts/check-guardrails.ts",
  "tests/unit/guardrails.test.ts",
];

/** Folders whose tests must never be deleted to make CI pass. */
export const PROTECTED_TEST_DIRS = ["tests/security/", "tests/regressions/"];

/** package.json scripts that CI runs. Changing one can quietly turn a check off. */
export const CHECK_SCRIPTS = [
  "build",
  "typecheck",
  "lint",
  "format:check",
  "test",
  "check:frontend",
  "check:infra",
  "check:guardrails",
  "smoke",
  "eval",
  "verify",
];

const SKIPPED_TEST =
  /\b(?:describe|it|test|suite)\s*\.\s*(?:skip|only|todo|skipIf)\b|\bx(?:describe|it|test)\s*\(/;
const SILENCED_CHECK = /eslint-disable|@ts-ignore|@ts-nocheck/;

function matches(path: string, patterns: string[]): boolean {
  return patterns.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
}

const isTestFile = (path: string) =>
  path.startsWith("tests/") || path.startsWith("evals/") || /\.test\.[cm]?[jt]sx?$/.test(path);

const isCodeFile = (path: string) => /\.[cm]?[jt]sx?$/.test(path);

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Compare the numbers in a JSON file before and after, and report moves in the wrong direction. */
function compareNumbers(
  change: ChangeSet,
  file: string,
  worse: "higher" | "lower",
  rule: string,
): Finding[] {
  const before = parseJson(change.readBase(file));
  if (!before) return [];
  const after = parseJson(change.readHead(file)) ?? {};
  const findings: Finding[] = [];
  for (const [key, old] of Object.entries(before)) {
    if (typeof old !== "number") continue;
    const now = after[key];
    if (typeof now !== "number") {
      findings.push({ rule, detail: `${file}: "${key}" was removed (it was ${old}).` });
    } else if (worse === "higher" ? now > old : now < old) {
      findings.push({ rule, detail: `${file}: "${key}" went from ${old} to ${now}.` });
    }
  }
  return findings;
}

export function findWeakenedChecks(change: ChangeSet): Finding[] {
  const findings: Finding[] = [];
  const isDependabot = change.author === "dependabot[bot]";

  // 1. Files that decide what gets checked
  for (const file of change.files) {
    for (const path of new Set([file.path, file.oldPath].filter((p): p is string => !!p))) {
      if (!matches(path, GUARDED_FILES)) continue;
      // Dependabot only bumps pinned action versions; let it through.
      if (isDependabot && path.startsWith(".github/workflows/")) continue;
      findings.push({ rule: "guarded file changed", detail: `${path} (${file.status})` });
    }
  }

  // 2. Deleted (or moved away) security and regression tests
  for (const file of change.files) {
    const gone =
      file.status === "D"
        ? file.path
        : file.status.startsWith("R") && file.oldPath && !matches(file.path, PROTECTED_TEST_DIRS)
          ? file.oldPath
          : undefined;
    if (gone && matches(gone, PROTECTED_TEST_DIRS)) {
      findings.push({ rule: "protected test removed", detail: gone });
    }
  }

  // 3 and 4. Skipped tests and silenced linter or type checker, in added lines.
  // Guarded files are skipped here: they already need approval, and the rules above
  // necessarily mention the very patterns they look for.
  for (const { path, line } of change.addedLines) {
    if (matches(path, GUARDED_FILES)) continue;
    if (isTestFile(path) && SKIPPED_TEST.test(line)) {
      findings.push({ rule: "test skipped", detail: `${path}: ${line.trim()}` });
    }
    if (isCodeFile(path) && SILENCED_CHECK.test(line)) {
      findings.push({ rule: "check silenced", detail: `${path}: ${line.trim()}` });
    }
  }

  // 5. Budgets raised, AI evaluation baseline lowered
  findings.push(...compareNumbers(change, "budgets.json", "higher", "budget raised"));
  findings.push(...compareNumbers(change, "evals/baseline.json", "lower", "baseline lowered"));

  // 6. The scripts CI runs, changed or removed
  const scriptsOf = (text: string | undefined) =>
    (parseJson(text)?.scripts ?? {}) as Record<string, string>;
  const beforeScripts = scriptsOf(change.readBase("package.json"));
  const afterScripts = scriptsOf(change.readHead("package.json"));
  for (const name of CHECK_SCRIPTS) {
    const old = beforeScripts[name];
    if (old !== undefined && afterScripts[name] !== old) {
      findings.push({
        rule: "check script changed",
        detail: `package.json "${name}": "${old}" became ${
          afterScripts[name] === undefined ? "(removed)" : `"${afterScripts[name]}"`
        }`,
      });
    }
  }

  return findings;
}

/** Parse `git diff --name-status -M` output. */
export function parseNameStatus(output: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [status = "", first = "", second] = line.split("\t");
    files.push(
      second === undefined ? { status, path: first } : { status, path: second, oldPath: first },
    );
  }
  return files;
}

/** Parse the added lines out of `git diff --unified=0` output. */
export function parseAddedLines(diff: string): AddedLine[] {
  const lines: AddedLine[] = [];
  let path: string | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      path = line.startsWith("+++ b/") ? line.slice(6) : undefined;
    } else if (line.startsWith("+") && path !== undefined) {
      lines.push({ path, line: line.slice(1) });
    }
  }
  return lines;
}
