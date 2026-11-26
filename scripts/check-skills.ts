// Skill linter: checks every agent skill (SKILL.md) in the repository, in CI and in npm run verify.
//
// The rules are in skills-lint.ts. Known failures that can't be fixed yet, such as third-party
// skills kept close to their originals, are listed in skills-waivers.json with a reason. That
// list can only shrink: a waiver that no longer matches a failure fails the check, and the
// Guardrails check flags any new one for a person to approve.
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { RULES, applyWaivers, lintSkill, type Finding, type WaiverFile } from "./skills-lint.js";

const WAIVERS = "skills-waivers.json";
const SKIP = new Set([".git", "node_modules", "dist", "coverage"]);
const root = process.cwd();
const toPosix = (path: string) => path.split(sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) walk(path, out);
    } else {
      out.push(path);
    }
  }
  return out;
}

const skills = walk(root)
  .filter((path) => path.endsWith(`${sep}SKILL.md`))
  .sort();

const findings: Finding[] = [];
const linted: string[] = [];
for (const file of skills) {
  const path = toPosix(relative(root, file));
  const folder = dirname(file);
  linted.push(path);
  findings.push(
    ...lintSkill({
      path,
      text: readFileSync(file, "utf8"),
      files: walk(folder).map((f) => toPosix(relative(folder, f))),
    }),
  );
}

const waivers: WaiverFile = existsSync(WAIVERS)
  ? (JSON.parse(readFileSync(WAIVERS, "utf8")) as WaiverFile)
  : { skills: {} };
const { failures, waived } = applyWaivers(findings, waivers, linted, WAIVERS);

const lines = [`Skills: checked ${linted.length} SKILL.md files.`];
for (const path of linted) {
  const failed = failures.filter((f) => f.path === path);
  const skipped = [...new Set(waived.filter((f) => f.path === path).map((f) => f.rule))];
  if (failed.length) {
    lines.push(`- FAIL ${path}`, ...failed.map((f) => `    ${f.rule}: ${f.detail}`));
  } else {
    lines.push(skipped.length ? `- waived ${path}: ${skipped.join(", ")}` : `- ok   ${path}`);
  }
}
for (const f of failures.filter((f) => !linted.includes(f.path))) {
  lines.push(`- FAIL ${f.path}`, `    ${f.rule}: ${f.detail}`);
}
if (failures.length) {
  lines.push(
    "",
    "Each skill must pass these rules. Fix the skill, not the rule:",
    ...Object.entries(RULES).map(([rule, text]) => `  ${rule}: ${text}`),
  );
}

const report = lines.join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${report}\n\`\`\`\n`);
}
if (failures.length) process.exit(1);
