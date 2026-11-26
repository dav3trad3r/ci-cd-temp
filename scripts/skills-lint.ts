// Skill linter rules: check that every agent skill (a SKILL.md file) can be found and followed.
//
// A skill is a set of steps an agent loads and follows on its own. A vague one fails quietly:
// the agent guesses a command, skips the check, or loops on "try again". These rules keep each
// skill in the shape that makes it dependable: a name and a short description so the right skill
// gets picked, numbered steps that each give a command and say how to check its result, and a
// list of known failures with their fixes. The file walking lives in check-skills.ts; this file
// is pure so it can be unit tested.

/** Each rule, as the sentence a passing skill satisfies. */
export const RULES = {
  name: "has a name: lowercase letters, digits and hyphens, 64 characters at most",
  description: "has a description of about 100 tokens or less",
  length: "keeps its body under 500 lines",
  steps: "has a Steps section with steps numbered 1, 2, 3",
  "step-objective": "opens each step with its one objective in bold",
  "step-command": "gives each step a concrete command",
  "step-check": "gives each step one Check: line that says how to confirm the result",
  recovery: "has an Error recovery section that lists failures and their fixes",
  "mcp-config": "ships no .mcp.json inside the skill",
} as const;

export type Rule = keyof typeof RULES;

export interface Finding {
  /** The SKILL.md path, relative to the repository root. */
  path: string;
  rule: Rule | "waiver";
  detail: string;
}

export interface SkillFile {
  /** The SKILL.md path, relative to the repository root. */
  path: string;
  text: string;
  /** Every file in the skill's folder, relative to that folder. */
  files: string[];
}

export const MAX_DESCRIPTION_TOKENS = 100;
export const MAX_BODY_LINES = 500;

/** A rough, model-neutral token count: about four characters a token for English text. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FENCE = /^\s*(?:```|~~~)/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const NUMBERED_ITEM = /^(\d+)[.)]\s+(.*)$/;
const BULLET_ITEM = /^[-*+]\s+(.*)$/;
/** Inline code with a space or a bracket in it reads as a command (`npm test`, `get_alert()`). */
const INLINE_COMMAND = /`[^`\n]*[\s(][^`\n]*`/;
const CHECK_LINE = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?Check:(?:\*\*|__)?\s*(.*)$/;
const RETRY_WORDS = /\b(?:again|retry|retrying|re-?run|re-?running|re-?try)\b/i;
/** Words that only say "do it again", so they don't count towards a real fix. */
const FILLER = new Set(
  (
    "a an and again after the then it it's that this just simply once more later wait few bit " +
    "minute minutes second seconds step command please same do try trying retry retrying " +
    "rerun re-run rerunning run running"
  ).split(" "),
);

interface Document {
  meta: Map<string, string> | undefined;
  body: string[];
  /** For each body line: is it inside a fenced code block (fence lines included)? */
  fenced: boolean[];
}

function unquote(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

/** Enough YAML for skill frontmatter: `key: value`, quoted values, and `>` or `|` blocks. */
function readFrontmatter(lines: string[]): Map<string, string> {
  const meta = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i] as string);
    if (!match) continue;
    const key = match[1] as string;
    const raw = (match[2] as string).trim();
    const block: string[] = [];
    while (i + 1 < lines.length && /^(?:\s+\S.*)?$/.test(lines[i + 1] as string)) {
      block.push((lines[++i] as string).trim());
    }
    if (/^[>|][+-]?$/.test(raw)) {
      meta.set(key, (raw.startsWith("|") ? block.join("\n") : block.join(" ")).trim());
    } else {
      meta.set(key, unquote([raw, ...block].join(" ").trim()));
    }
  }
  return meta;
}

function parse(text: string): Document {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  let meta: Map<string, string> | undefined;
  let body = lines;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (end > 0) {
      meta = readFrontmatter(lines.slice(1, end));
      body = lines.slice(end + 1);
    }
  }
  const fenced: boolean[] = [];
  let open = false;
  for (const line of body) {
    if (FENCE.test(line)) {
      fenced.push(true);
      open = !open;
    } else {
      fenced.push(open);
    }
  }
  return { meta, body, fenced };
}

interface Section {
  lines: string[];
  fenced: boolean[];
}

/** The lines under the first heading that matches, up to the next heading at its level or above. */
function findSection(doc: Document, title: RegExp): Section | undefined {
  let start = -1;
  let level = 0;
  for (let i = 0; i < doc.body.length; i++) {
    if (doc.fenced[i]) continue;
    const heading = HEADING.exec(doc.body[i] as string);
    if (!heading) continue;
    const depth = (heading[1] as string).length;
    if (start >= 0 && depth <= level) {
      return { lines: doc.body.slice(start, i), fenced: doc.fenced.slice(start, i) };
    }
    if (start < 0 && title.test(heading[2] as string)) {
      start = i + 1;
      level = depth;
    }
  }
  return start < 0 ? undefined : { lines: doc.body.slice(start), fenced: doc.fenced.slice(start) };
}

interface Item {
  /** The marker's number, for a numbered list. */
  number?: number;
  /** The text after the marker on the item's first line. */
  first: string;
  /** Every line of the item, the first included. */
  lines: string[];
  fenced: boolean[];
}

/** Top-level list items: each runs until a line at the left margin that isn't part of it. */
function listItems(section: Section, marker: RegExp): Item[] {
  const items: Item[] = [];
  let current: Item | undefined;
  section.lines.forEach((line, i) => {
    const inFence = section.fenced[i] as boolean;
    const match = inFence ? null : marker.exec(line);
    if (match) {
      const number = match.length > 2 ? Number(match[1]) : undefined;
      current = {
        number,
        first: match[match.length - 1] as string,
        lines: [line],
        fenced: [false],
      };
      items.push(current);
    } else if (current && (inFence || line.trim() === "" || /^\s/.test(line))) {
      current.lines.push(line);
      current.fenced.push(inFence);
    } else if (line.trim() !== "") {
      current = undefined;
    }
  });
  return items;
}

const words = (text: string) => text.split(/\s+/).filter(Boolean);

/** True when a fix says no more than "try again", however it's worded. */
export function onlyRetries(fix: string): boolean {
  if (!RETRY_WORDS.test(fix)) return false;
  const left = words(fix.replace(/`[^`]*`/g, " code ").replace(/[^\w\s'-]/g, " "))
    .map((word) => word.toLowerCase())
    .filter((word) => !FILLER.has(word) && !/^\d+$/.test(word));
  return left.length < 3;
}

function lintSteps(path: string, doc: Document): Finding[] {
  const found = (rule: Rule, detail: string): Finding => ({ path, rule, detail });
  const section = findSection(doc, /^steps\b/i);
  if (!section) {
    return [found("steps", "add a `## Steps` section with numbered steps (1., 2., 3.).")];
  }
  const items = listItems(section, NUMBERED_ITEM);
  if (items.length === 0) {
    return [found("steps", "the Steps section has no numbered steps (1., 2., 3.).")];
  }
  const findings: Finding[] = [];
  const numbers = items.map((item) => item.number);
  if (numbers.some((n, i) => n !== i + 1)) {
    findings.push(
      found("steps", `the steps are numbered ${numbers.join(", ")}: number them in order from 1.`),
    );
  }
  // Steps that break each part of a rule, reported once per part rather than once per step.
  const broken = {
    noObjective: [] as number[],
    longObjective: [] as number[],
    noCommand: [] as number[],
    noCheck: [] as number[],
    manyChecks: [] as number[],
    thinCheck: [] as number[],
  };
  items.forEach((item, i) => {
    const step = i + 1;
    const objective = /^\*\*([^*]+)\*\*/.exec(item.first);
    if (!objective) broken.noObjective.push(step);
    else if (words(objective[1] as string).length > 12) broken.longObjective.push(step);
    const hasBlock = item.fenced.some(Boolean);
    const hasInline = item.lines.some((line, j) => !item.fenced[j] && INLINE_COMMAND.test(line));
    if (!hasBlock && !hasInline) broken.noCommand.push(step);
    const checks = item.lines
      .filter((_, j) => !item.fenced[j])
      .map((line) => CHECK_LINE.exec(line))
      .filter((match): match is RegExpExecArray => match !== null);
    if (checks.length === 0) broken.noCheck.push(step);
    else if (checks.length > 1) broken.manyChecks.push(step);
    else if (words(checks[0]?.[1] ?? "").length < 3) broken.thinCheck.push(step);
  });
  const report = (rule: Rule, steps: number[], problem: string) => {
    if (steps.length) findings.push(found(rule, `${stepList(steps)}: ${problem}`));
  };
  report(
    "step-objective",
    broken.noObjective,
    "open with the step's one objective in bold, like **Find what changed.**",
  );
  report(
    "step-objective",
    broken.longObjective,
    "the objective runs past 12 words. Keep it to one goal.",
  );
  report(
    "step-command",
    broken.noCommand,
    "no command. Give the exact command or tool call, in backticks or a code block.",
  );
  report("step-check", broken.noCheck, "no `Check:` line saying how to confirm the result.");
  report(
    "step-check",
    broken.manyChecks,
    "more than one check. Split the step so each has one objective and one check.",
  );
  report("step-check", broken.thinCheck, "the check is too short to act on. Say what to look for.");
  return findings;
}

/** "step 3", "steps 1 and 2", "steps 1, 2 and 6". */
function stepList(steps: number[]): string {
  if (steps.length === 1) return `step ${steps[0]}`;
  return `steps ${steps.slice(0, -1).join(", ")} and ${steps.at(-1)}`;
}

interface RecoveryEntry {
  /** What failed. Undefined when the entry doesn't name it. */
  failure?: string;
  fix: string;
}

/** `- **<what failed>** <how to fix it>` list items. */
function recoveryList(section: Section): RecoveryEntry[] {
  return listItems(section, BULLET_ITEM).map((item) => {
    const text = item.lines
      .map((line) => line.trim())
      .join(" ")
      .replace(BULLET_ITEM, "$1");
    const entry = /^\*\*(.+?)\*\*[:.]?\s*(.*)$/.exec(text);
    return entry
      ? { failure: entry[1] as string, fix: (entry[2] as string).trim() }
      : { fix: text };
  });
}

/** Rows of a table whose first column is what failed and whose second is the fix. */
function recoveryTable(section: Section): RecoveryEntry[] {
  const rows = section.lines
    .filter((line, i) => !section.fenced[i] && line.trim().startsWith("|"))
    .map((line) =>
      line
        .trim()
        .replace(/^\||\|$/g, "")
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim()),
    );
  const separator = rows.findIndex((cells) => cells.every((cell) => /^:?-{3,}:?$/.test(cell)));
  if (separator !== 1) return [];
  return rows.slice(2).map((cells) => {
    const failure = cells[0]?.replace(/^\*\*(.*)\*\*$/, "$1");
    return { failure: failure || undefined, fix: cells.slice(1).join(" ").trim() };
  });
}

function lintRecovery(path: string, doc: Document): Finding[] {
  const found = (detail: string): Finding => ({ path, rule: "recovery", detail });
  const section = findSection(doc, /recover|if (?:a step|something|it) fails|troubleshoot/i);
  const shape =
    "a list of `- **<what failed>** <how to fix it>` entries, or a table with a failure and a fix in each row";
  if (!section) return [found(`add an \`## Error recovery\` section: ${shape}.`)];
  const entries = [...recoveryList(section), ...recoveryTable(section)];
  if (entries.length === 0) return [found(`the Error recovery section needs ${shape}.`)];
  const findings: Finding[] = [];
  entries.forEach(({ failure, fix }, i) => {
    if (failure === undefined) {
      findings.push(found(`entry ${i + 1} should name the failure in bold, then give its fix.`));
    } else if (!fix) {
      findings.push(found(`"${failure}" has no fix.`));
    } else if (onlyRetries(fix)) {
      findings.push(
        found(`"${failure}": "${fix}" only says to try again. Say what to change first.`),
      );
    }
  });
  return findings;
}

/** Check one skill. Returns nothing when it passes every rule. */
export function lintSkill(skill: SkillFile): Finding[] {
  const { path } = skill;
  const found = (rule: Rule, detail: string): Finding => ({ path, rule, detail });
  const doc = parse(skill.text);
  const findings: Finding[] = [];

  const name = doc.meta?.get("name");
  if (!doc.meta) {
    findings.push(
      found(
        "name",
        "the file has no frontmatter: start it with ---, name: and description:, then ---.",
      ),
    );
  } else if (!name) {
    findings.push(found("name", "add `name:` to the frontmatter."));
  } else if (!NAME.test(name) || name.length > 64) {
    findings.push(
      found(
        "name",
        `"${name}" should be lowercase letters, digits and hyphens, 64 characters at most.`,
      ),
    );
  }

  const description = doc.meta?.get("description");
  if (doc.meta && !description) {
    findings.push(
      found(
        "description",
        "add `description:` to the frontmatter: what the skill does and when to use it.",
      ),
    );
  } else if (description && estimateTokens(description) > MAX_DESCRIPTION_TOKENS) {
    findings.push(
      found(
        "description",
        `the description is about ${estimateTokens(description)} tokens: cut it to ${MAX_DESCRIPTION_TOKENS} or fewer.`,
      ),
    );
  }

  if (doc.body.length >= MAX_BODY_LINES) {
    findings.push(
      found(
        "length",
        `the body is ${doc.body.length} lines: keep it under ${MAX_BODY_LINES} and move detail into files the skill links to.`,
      ),
    );
  }

  findings.push(...lintSteps(path, doc), ...lintRecovery(path, doc));

  for (const file of skill.files) {
    if (file.split("/").at(-1) === ".mcp.json") {
      findings.push(
        found(
          "mcp-config",
          `${file} is inside the skill: declare tool servers in the repository's agent settings, not in a skill.`,
        ),
      );
    }
  }
  return findings;
}

export interface Waiver {
  reason: string;
  rules: string[];
}

export interface WaiverFile {
  skills: Record<string, Waiver>;
}

/**
 * Split findings into failures and waived ones. A waiver that no longer matches anything is a
 * failure too, so the list can only shrink: fix a skill and its waiver has to go.
 */
export function applyWaivers(
  findings: Finding[],
  waivers: WaiverFile,
  linted: string[],
  file = "skills-waivers.json",
): { failures: Finding[]; waived: Finding[] } {
  const failures: Finding[] = [];
  const waived: Finding[] = [];
  for (const finding of findings) {
    const waiver = waivers.skills[finding.path];
    (waiver?.rules.includes(finding.rule) ? waived : failures).push(finding);
  }
  for (const [path, waiver] of Object.entries(waivers.skills)) {
    const stale = (detail: string) => failures.push({ path, rule: "waiver", detail });
    if (!linted.includes(path)) {
      stale(`no skill at this path: remove its entry from ${file}.`);
      continue;
    }
    if (!waiver.reason?.trim()) stale(`give its waiver in ${file} a reason.`);
    for (const rule of waiver.rules) {
      if (!(rule in RULES)) {
        stale(
          `${file} waives "${rule}", which isn't a rule. The rules are: ${Object.keys(RULES).join(", ")}.`,
        );
      } else if (!findings.some((f) => f.path === path && f.rule === rule)) {
        stale(`it now passes "${rule}": remove that rule from its waiver in ${file}.`);
      }
    }
  }
  return { failures, waived };
}
