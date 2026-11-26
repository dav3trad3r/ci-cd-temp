// Guardrail rules: spot a change that weakens the checks instead of fixing the code.
//
// AI coding agents (and tired people) often "fix" a red build by skipping the failing
// test, raising a budget or silencing the linter. These rules find those changes in a
// pull request so a person has to approve them on purpose. Tools arrive with their own
// layouts, so the rules go by what a file is rather than where this template keeps it.
// The git plumbing lives in check-guardrails.ts; this file is pure so it can be unit tested.
import { baselineLoosened, type Baseline } from "./platform/baseline.js";

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

/** This platform's own files that decide what gets checked. */
export const GUARDED_FILES = [
  ".github/workflows/",
  ".github/CODEOWNERS",
  ".github/rulesets/",
  "actions/",
  "platform/files/",
  "scripts/platform/",
  "ops/platform.json",
  "scripts/rulesets.ts",
  "scripts/apply-rulesets.ts",
  "bicepconfig.json",
  "scripts/check-frontend.mjs",
  "scripts/check-infra.mjs",
  "scripts/smoke.mjs",
  "scripts/skills-lint.ts",
  "scripts/check-skills.ts",
  "tests/unit/skills-lint.test.ts",
  "evals/run.ts",
  "scripts/guardrails.ts",
  "scripts/check-guardrails.ts",
  "tests/unit/guardrails.test.ts",
  "tests/regressions/2026-11-23-guardrails-layouts.test.ts",
];

/** Settings for any tool's checks, in whichever folder and format it keeps them. */
const GUARDED_PATTERNS = [
  /(?:^|\/)\.platform\//,
  /(?:^|\/)\.claude\//,
  /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/,
  /(?:^|\/)\.gitleaks(?:ignore|\.toml)$/,
  /(?:^|\/)\.gitattributes$/,
  /^\.github\/dependabot\.ya?ml$/,
  /(?:^|\/)eslint\.config\.[cm]?[jt]s$/,
  /(?:^|\/)\.eslint(?:rc(?:\.\w+)?|ignore)$/,
  /(?:^|\/)biome\.jsonc?$/,
  /(?:^|\/)(?:vitest|vite|jest|playwright|cypress|ava)\.(?:config|workspace|setup)\.[\w.]+$/,
  /(?:^|\/)\.(?:mocharc|nycrc|c8rc)(?:\.\w+)?$/,
  /(?:^|\/)tsconfig[\w.-]*\.json$/,
  /(?:^|\/)\.prettier(?:rc(?:\.\w+)?|ignore)$/,
  /(?:^|\/)prettier\.config\.[cm]?[jt]s$/,
];

/** A tool's allowance for old problems. Lowering it is always fine; raising it needs a person. */
const BASELINE_FILE = ".platform/baseline.json";

/** Skills allowed to fail the skill linter for now. Removing a waiver is fine; adding one needs a person. */
const SKILL_WAIVERS = "skills-waivers.json";

/** Folders whose tests must never be moved out to make CI pass. */
const PROTECTED_TESTS = /(?:^|\/)tests?\/(?:security|regressions)\//;

/** package.json scripts that CI runs in this template. Other tools' are worked out below. */
export const CHECK_SCRIPTS = [
  "build",
  "typecheck",
  "lint",
  "format:check",
  "test",
  "check:frontend",
  "check:infra",
  "check:skills",
  "check:guardrails",
  "smoke",
  "eval",
  "verify",
];

/** Script names that run a check, such as test:unit, type-check or fmt:check. */
const CHECK_SCRIPT_NAME =
  /^(?:pre|post)?(?:test|lint|format|fmt|prettier|type-?check|check|tsc|build|smoke|evals?|verify|ci)(?:$|[:\-_.])/i;

/** One script calling another: `npm run unit`, `pnpm unit`, `yarn run unit`. */
const SCRIPT_CALL = /\b(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?(?:--\S+\s+)*([\w:.-]+)/g;

/** Settings for a check that can live inside package.json. */
const CONFIG_IN_PACKAGE = [
  "jest",
  "mocha",
  "ava",
  "nyc",
  "c8",
  "eslintConfig",
  "eslintIgnore",
  "prettier",
];

const SKIP_WORDS = "skip|only|todo|skipIf|runIf|fails";
const SKIPPED_TEST = new RegExp(
  [
    // it.skip, test.only, it.concurrent.skip, describe.skipIf, it.fails
    `\\b(?:describe|context|suite|it|test|specify)(?:\\s*\\.\\s*\\w+)*\\s*\\.\\s*(?:${SKIP_WORDS})\\b`,
    // A chain broken across lines
    `^\\s*\\.\\s*(?:${SKIP_WORDS})\\b`,
    `\\bx(?:describe|context|it|test|specify)\\s*\\(`,
    `\\bf(?:describe|context|it|test)\\s*\\(`,
    `\\b(?:this|ctx|context|t)\\s*\\.\\s*skip\\s*\\(`,
  ].join("|"),
);
const SILENCED_CHECK =
  /eslint-disable|@ts-ignore|@ts-nocheck|@ts-expect-error|biome-ignore|oxlint-disable|prettier-ignore|(?:c8|v8|istanbul) ignore/;
const EMPTY_ASSERTION =
  /\bexpect\(\s*(?:true|false|1|0|null|undefined)\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual|toBeTruthy|toBeFalsy|toBeNull|toBeDefined|toBeUndefined)\b/;
const ASSERTION = /\bexpect(?:TypeOf)?\s*\(|\bassert(?:\.\w+)?\s*\(/g;

function matches(path: string, patterns: string[]): boolean {
  return patterns.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
}

const isGuarded = (path: string) =>
  matches(path, GUARDED_FILES) || GUARDED_PATTERNS.some((pattern) => pattern.test(path));

const isCodeFile = (path: string) => /\.(?:[cm]?[jt]sx?|vue|svelte|astro|mdx|html?)$/.test(path);

const isTestFile = (path: string) =>
  /(?:^|\/)(?:tests?|__tests__|specs?|e2e|cypress|evals)\/|\.(?:test|spec|e2e|cy)\.[cm]?[jt]sx?$/.test(
    path,
  );

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

/** Waivers in skills-waivers.json that weren't there before: each lets a skill fail a linter rule. */
function waiversAdded(change: ChangeSet): Finding[] {
  if (!change.files.some((f) => f.path === SKILL_WAIVERS && f.status !== "D")) return [];
  type Waivers = Record<string, { rules?: unknown } | undefined>;
  const read = (text: string | undefined) => parseJson(text)?.skills as Waivers | undefined;
  const rule = "skill waiver added";
  const after = read(change.readHead(SKILL_WAIVERS));
  if (!after || typeof after !== "object") {
    return [{ rule, detail: `${SKILL_WAIVERS} can't be read.` }];
  }
  const before = read(change.readBase(SKILL_WAIVERS)) ?? {};
  const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
  const findings: Finding[] = [];
  for (const [path, waiver] of Object.entries(after)) {
    const old = new Set(list(before[path]?.rules));
    for (const waived of list(waiver?.rules)) {
      if (!old.has(waived)) {
        findings.push({ rule, detail: `${SKILL_WAIVERS}: ${path} may now fail "${waived}".` });
      }
    }
  }
  return findings;
}

/** Dependabot may move the version of an action a workflow already uses, and nothing else. */
function onlyBumpsActions(change: ChangeSet, path: string): boolean {
  const withoutVersions = (text: string) =>
    text.replace(/^(\s*(?:-\s*)?uses:\s*[^@\s]+)@\S+(?:[ \t]+#.*)?$/gm, "$1");
  const before = change.readBase(path);
  const after = change.readHead(path);
  return (
    before !== undefined &&
    after !== undefined &&
    withoutVersions(before) === withoutVersions(after)
  );
}

/** The scripts that run a check: by name, from the tool's manifest, and whatever those call. */
function checkScriptNames(scripts: Record<string, string>, change: ChangeSet): Set<string> {
  const manifest = parseJson(change.readBase(".platform/tool.json")) as
    { commands?: Record<string, string | null> } | undefined;
  const wanted = new Set([
    ...CHECK_SCRIPTS,
    ...Object.keys(scripts).filter((name) => CHECK_SCRIPT_NAME.test(name)),
  ]);
  for (const command of Object.values(manifest?.commands ?? {})) {
    for (const call of (command ?? "").matchAll(SCRIPT_CALL)) wanted.add(call[1] as string);
  }
  const queue = [...wanted];
  while (queue.length) {
    const name = queue.pop() as string;
    for (const related of [`pre${name}`, `post${name}`]) {
      if (scripts[related] !== undefined && !wanted.has(related)) {
        wanted.add(related);
        queue.push(related);
      }
    }
    for (const call of (scripts[name] ?? "").matchAll(SCRIPT_CALL)) {
      const called = call[1] as string;
      if (!wanted.has(called)) {
        wanted.add(called);
        queue.push(called);
      }
    }
  }
  return wanted;
}

function packageFindings(change: ChangeSet, file: string): Finding[] {
  const before = parseJson(change.readBase(file));
  const after = parseJson(change.readHead(file));
  const findings: Finding[] = [];
  const beforeScripts = (before?.scripts ?? {}) as Record<string, string>;
  const afterScripts = (after?.scripts ?? {}) as Record<string, string>;
  for (const name of checkScriptNames(beforeScripts, change)) {
    const old = beforeScripts[name];
    if (old !== undefined && afterScripts[name] !== old) {
      findings.push({
        rule: "check script changed",
        detail: `${file} "${name}": "${old}" became ${
          afterScripts[name] === undefined ? "(removed)" : `"${afterScripts[name]}"`
        }`,
      });
    }
  }
  for (const key of CONFIG_IN_PACKAGE) {
    if (JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])) {
      findings.push({ rule: "check settings changed", detail: `${file}: the "${key}" block` });
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
      if (!isGuarded(path) || path === BASELINE_FILE) continue;
      if (
        isDependabot &&
        file.status === "M" &&
        path.startsWith(".github/workflows/") &&
        onlyBumpsActions(change, path)
      ) {
        continue;
      }
      findings.push({ rule: "guarded file changed", detail: `${path} (${file.status})` });
    }
  }

  // 2. Deleted tests, or tests moved somewhere they won't run
  for (const file of change.files) {
    const renamed = file.status.startsWith("R") ? file.oldPath : undefined;
    const gone =
      file.status === "D"
        ? file.path
        : renamed &&
            (!isTestFile(file.path) ||
              !isCodeFile(file.path) ||
              (PROTECTED_TESTS.test(renamed) && !PROTECTED_TESTS.test(file.path)))
          ? renamed
          : undefined;
    if (gone && isTestFile(gone) && isCodeFile(gone) && !isGuarded(gone)) {
      findings.push({ rule: "protected test removed", detail: gone });
    }
  }

  // 3 and 4. Skipped tests and silenced checks, in added lines. Guarded files are skipped here:
  // they already need approval, and the rules above necessarily mention these very patterns.
  for (const { path, line } of change.addedLines) {
    if (isGuarded(path)) continue;
    if (isCodeFile(path) && isTestFile(path) && SKIPPED_TEST.test(line)) {
      findings.push({ rule: "test skipped", detail: `${path}: ${line.trim()}` });
    }
    if (isCodeFile(path) && isTestFile(path) && EMPTY_ASSERTION.test(line)) {
      findings.push({ rule: "assertion weakened", detail: `${path}: ${line.trim()}` });
    }
    if ((isCodeFile(path) && SILENCED_CHECK.test(line)) || line.includes("gitleaks:allow")) {
      findings.push({ rule: "check silenced", detail: `${path}: ${line.trim()}` });
    }
  }

  // 4b. A test file that now asserts less than it did
  for (const file of change.files) {
    if (file.status !== "M" && !file.status.startsWith("R")) continue;
    if (!isTestFile(file.path) || !isCodeFile(file.path) || isGuarded(file.path)) continue;
    const before = change.readBase(file.oldPath ?? file.path);
    const after = change.readHead(file.path);
    if (before === undefined || after === undefined) continue;
    const was = before.match(ASSERTION)?.length ?? 0;
    const now = after.match(ASSERTION)?.length ?? 0;
    if (now < was) {
      findings.push({
        rule: "assertion weakened",
        detail: `${file.path}: ${was} assertions became ${now}`,
      });
    }
  }

  // 5. Budgets raised, AI evaluation baseline lowered
  findings.push(...compareNumbers(change, "budgets.json", "higher", "budget raised"));
  findings.push(...compareNumbers(change, "evals/baseline.json", "lower", "baseline lowered"));

  // 5b. A tool's baseline may only shrink
  if (change.files.some((f) => f.path === BASELINE_FILE && f.status !== "D")) {
    const after = parseJson(change.readHead(BASELINE_FILE)) as Baseline | undefined;
    const before = parseJson(change.readBase(BASELINE_FILE)) as Baseline | undefined;
    if (!after?.checks) {
      findings.push({ rule: "baseline raised", detail: `${BASELINE_FILE} can't be read.` });
    } else {
      for (const detail of baselineLoosened(before, after)) {
        findings.push({ rule: "baseline raised", detail: `${BASELINE_FILE}: ${detail}` });
      }
    }
  } else if (change.files.some((f) => f.path === BASELINE_FILE && f.status === "D")) {
    findings.push({ rule: "baseline raised", detail: `${BASELINE_FILE} was deleted.` });
  }

  // 5c. Skill-linter waivers may only shrink
  findings.push(...waiversAdded(change));

  // 6. The scripts CI runs and any check settings in package.json, in every package
  const packages = new Set(["package.json"]);
  for (const file of change.files) {
    for (const path of [file.path, file.oldPath]) {
      if (path && /(?:^|\/)package\.json$/.test(path)) packages.add(path);
    }
  }
  for (const file of packages) findings.push(...packageFindings(change, file));

  return findings;
}

/** Parse `git diff --name-status -M`, with or without -z. */
export function parseNameStatus(output: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  if (output.includes("\0")) {
    const parts = output.split("\0");
    for (let i = 0; i < parts.length - 1;) {
      const status = parts[i++] as string;
      const first = parts[i++] as string;
      if (/^[RC]/.test(status)) files.push({ status, oldPath: first, path: parts[i++] as string });
      else files.push({ status, path: first });
    }
    return files;
  }
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [status = "", first = "", second] = line.split("\t");
    files.push(
      second === undefined ? { status, path: first } : { status, path: second, oldPath: first },
    );
  }
  return files;
}

const GIT_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/** Git wraps an unusual path in quotes and escapes it, with bytes written in octal. */
function unquotePath(quoted: string): string {
  const body = Array.from(quoted.slice(1, -1));
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const char = body[i] as string;
    if (char !== "\\") {
      bytes.push(...Buffer.from(char));
      continue;
    }
    const octal = body.slice(i + 1, i + 4).join("");
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 3;
    } else {
      const next = body[++i] ?? "";
      bytes.push(GIT_ESCAPES[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function headerPath(text: string): string | undefined {
  const value = text.replace(/\t.*$/, "");
  const path = value.startsWith('"') ? unquotePath(value) : value;
  return path.startsWith("b/") ? path.slice(2) : undefined;
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * Parse the added lines out of `git diff` output. It counts each hunk's lines, so an added line
 * that happens to start with "++ b/" can't be mistaken for the next file's header.
 */
export function parseAddedLines(diff: string): AddedLine[] {
  const lines: AddedLine[] = [];
  let path: string | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("+")) {
        newLeft -= 1;
        if (path !== undefined) lines.push({ path, line: line.slice(1) });
      } else if (line.startsWith("-")) {
        oldLeft -= 1;
      } else if (line.startsWith(" ")) {
        oldLeft -= 1;
        newLeft -= 1;
      }
      continue;
    }
    if (line.startsWith("+++ ")) {
      path = headerPath(line.slice(4));
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldLeft = Number(hunk[1] ?? 1);
      newLeft = Number(hunk[2] ?? 1);
    }
  }
  return lines;
}
