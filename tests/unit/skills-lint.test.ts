import { describe, expect, test } from "vitest";
import {
  applyWaivers,
  lintSkill,
  onlyRetries,
  type Finding,
  type WaiverFile,
} from "../../scripts/skills-lint.js";

const PATH = ".claude/skills/example/SKILL.md";

const FRONTMATTER = `---
name: example
description: Checks an example. Use it when a test needs a skill that passes.
---`;

const STEPS = `## Steps

1. **Run the tests.** Run \`npm test\`.

   Check: the run ends with every test passing.

2. **Build it.**

   \`\`\`bash
   npm run build
   \`\`\`

   Check: \`dist/\` holds the new build.`;

const RECOVERY = `## Error recovery

- **\`npm test\` can't find a module.** Run \`npm ci\` to install from the lockfile.
- **The build runs out of memory.** Set \`NODE_OPTIONS=--max-old-space-size=4096\` before the build.`;

const skill = (text: string, files: string[] = ["SKILL.md"]) => ({ path: PATH, text, files });
const passing = [FRONTMATTER, "# Example", STEPS, RECOVERY].join("\n\n");
const rules = (text: string, files?: string[]) =>
  lintSkill(skill(text, files)).map((finding) => finding.rule);

describe("skill linter", () => {
  test("a skill in the right shape passes", () => {
    expect(lintSkill(skill(passing))).toEqual([]);
  });

  test("reads Windows line endings and quoted or folded descriptions", () => {
    expect(rules(passing.replace(/\n/g, "\r\n"))).toEqual([]);
    const quoted = passing.replace(
      /description: .*/,
      'description: "Checks an \\"example\\". Use it in tests."',
    );
    expect(rules(quoted)).toEqual([]);
    const folded = passing.replace(
      /description: .*/,
      "description: >\n  Checks an example.\n  Use it in tests.",
    );
    expect(rules(folded)).toEqual([]);
  });

  test("needs a name in lowercase letters, digits and hyphens", () => {
    expect(rules(passing.replace("name: example", ""))).toEqual(["name"]);
    expect(rules(passing.replace("name: example", "name: Example_Skill"))).toEqual(["name"]);
    expect(rules(passing.replace(FRONTMATTER, ""))).toEqual(["name"]);
  });

  test("needs a description of about 100 tokens or less", () => {
    expect(rules(passing.replace(/description: .*/, ""))).toEqual(["description"]);
    const long = `description: ${"Checks an example in some detail. ".repeat(14)}`;
    expect(rules(passing.replace(/description: .*/, long))).toEqual(["description"]);
  });

  test("keeps the body under 500 lines", () => {
    const filler = Array.from({ length: 500 }, (_, i) => `Line ${i}.`).join("\n");
    expect(rules(`${passing}\n\n## Notes\n\n${filler}`)).toEqual(["length"]);
  });

  test("needs a Steps section with steps numbered in order", () => {
    expect(rules(passing.replace("## Steps", "## How it works"))).toEqual(["steps"]);
    expect(rules(passing.replace("2. **Build it.**", "3. **Build it.**"))).toEqual(["steps"]);
  });

  test("each step opens with one objective in bold", () => {
    const findings = lintSkill(skill(passing.replace("**Run the tests.** ", "")));
    expect(findings.map((f) => f.rule)).toEqual(["step-objective"]);
    expect(findings[0]?.detail).toMatch(/^step 1:/);
  });

  test("each step gives a concrete command", () => {
    expect(rules(passing.replace("Run `npm test`.", "Run the tests."))).toEqual(["step-command"]);
    // A file name in backticks is not a command.
    expect(rules(passing.replace("Run `npm test`.", "See `package.json`."))).toEqual([
      "step-command",
    ]);
  });

  test("each step has exactly one check that says what to look for", () => {
    const noCheck = passing.replace("   Check: the run ends with every test passing.", "");
    expect(rules(noCheck)).toEqual(["step-check"]);
    const twoChecks = passing.replace(
      "   Check: the run ends with every test passing.",
      "   Check: the run ends with every test passing.\n\n   Check: no test was skipped.",
    );
    expect(rules(twoChecks)).toEqual(["step-check"]);
    expect(
      rules(passing.replace("Check: the run ends with every test passing.", "Check: ok")),
    ).toEqual(["step-check"]);
  });

  test("reports a broken part once, naming every step that breaks it", () => {
    const text = passing.replace(/\n\n {3}Check: .*/g, "");
    const findings = lintSkill(skill(text));
    expect(findings).toEqual([
      { path: PATH, rule: "step-check", detail: expect.stringMatching(/^steps 1 and 2:/) },
    ]);
  });

  test("ignores numbered lines inside code blocks", () => {
    const text = passing.replace("   npm run build", "   npm run build\n   1. not a step");
    expect(rules(text)).toEqual([]);
  });

  test("needs an error-recovery section that lists failures and fixes", () => {
    expect(rules(passing.replace(RECOVERY, ""))).toEqual(["recovery"]);
    expect(rules(passing.replace(/- \*\*The build[^\n]*/, "- Ask someone."))).toEqual(["recovery"]);
    expect(rules(passing.replace(/- \*\*The build[^\n]*/, "- **The build fails.**"))).toEqual([
      "recovery",
    ]);
  });

  test('"try again" is not a fix', () => {
    for (const fix of [
      "Try again.",
      "Retry.",
      "Run `npm test` again.",
      "Wait 60 seconds and retry.",
    ]) {
      const text = passing.replace(/(- \*\*The build runs out of memory\.\*\*) .*/, `$1 ${fix}`);
      expect(rules(text), fix).toEqual(["recovery"]);
    }
  });

  test("the failures and fixes can be a table", () => {
    const table = (rows: string) =>
      passing.replace(RECOVERY, `## Error recovery\n\n| Failure | Fix |\n| --- | --- |\n${rows}`);
    expect(rules(table("| `npm test` can't find a module | Run `npm ci` first. |"))).toEqual([]);
    expect(
      rules(table("| **The build fails** | Read the first error and fix that file. |")),
    ).toEqual([]);
    expect(rules(table("| The build fails | Try again. |"))).toEqual(["recovery"]);
    expect(rules(table("| The build fails | |"))).toEqual(["recovery"]);
    expect(rules(table(""))).toEqual(["recovery"]);
  });

  test("a fix may retry once it says what to change", () => {
    expect(onlyRetries("Retry with `--since 120` to widen the window.")).toBe(false);
    expect(onlyRetries("Correct what each reason names and call it once more.")).toBe(false);
    expect(onlyRetries("Use the file.")).toBe(false);
    expect(onlyRetries("Try it again later.")).toBe(true);
  });

  test("ships no .mcp.json inside the skill", () => {
    expect(rules(passing, ["SKILL.md", ".mcp.json"])).toEqual(["mcp-config"]);
    expect(rules(passing, ["SKILL.md", "examples/.mcp.json"])).toEqual(["mcp-config"]);
  });
});

describe("skill waivers", () => {
  const finding = (rule: Finding["rule"]): Finding => ({ path: PATH, rule, detail: "x" });
  const waivers = (rules: string[], reason = "Third-party copy."): WaiverFile => ({
    skills: { [PATH]: { reason, rules } },
  });

  test("a waived rule doesn't fail", () => {
    const result = applyWaivers([finding("recovery")], waivers(["recovery"]), [PATH]);
    expect(result.failures).toEqual([]);
    expect(result.waived.map((f) => f.rule)).toEqual(["recovery"]);
  });

  test("a rule that isn't waived still fails", () => {
    const result = applyWaivers([finding("steps")], waivers(["recovery"]), [PATH]);
    expect(result.failures.map((f) => f.rule)).toContain("steps");
  });

  test("a waiver the skill no longer needs fails, so the list can only shrink", () => {
    const result = applyWaivers([], waivers(["recovery"]), [PATH]);
    expect(result.failures).toEqual([
      { path: PATH, rule: "waiver", detail: expect.stringContaining('now passes "recovery"') },
    ]);
  });

  test("a waiver needs a real rule, a reason and a skill that exists", () => {
    expect(applyWaivers([], waivers(["no-such-rule"]), [PATH]).failures).toHaveLength(1);
    expect(
      applyWaivers([finding("recovery")], waivers(["recovery"], " "), [PATH]).failures,
    ).toHaveLength(1);
    expect(applyWaivers([], waivers(["recovery"]), []).failures[0]?.detail).toMatch(/no skill/);
  });
});
