// The review and merge rules for main (.github/rulesets/), as pure functions so they're
// unit-tested (tests/unit/rulesets.test.ts). apply-rulesets.ts sends them to GitHub.
//
// Two rulesets, because GitHub applies every ruleset that matches a branch, and an exemption
// from one ruleset doesn't exempt you from another:
// - "Protect main": a pull request, an approval from a code owner (the Pipeline approvers team)
//   that isn't from whoever pushed last, fresh approval after new commits, resolved threads, and
//   the Checks and Guardrails jobs. Nobody is exempt.
// - "Only Pipeline approvers merge": nobody may update main except that team, and only through
//   a pull request. Being exempt here doesn't exempt them from "Protect main".

export interface BypassActor {
  actor_type: string;
  actor_id: number | null;
  bypass_mode: string;
}

export interface Rule {
  type: string;
  parameters?: Record<string, unknown>;
}

export interface Ruleset {
  name: string;
  target: string;
  enforcement: string;
  conditions: Record<string, { include: string[]; exclude: string[] }>;
  bypass_actors: BypassActor[];
  rules: Rule[];
}

/** Fills in the team's ID, and for an organisation-wide ruleset, applies it to every repository. */
export function forScope(
  template: Ruleset,
  opts: { teamId: number; scope: "org" | "repo" },
): Ruleset {
  const ruleset = JSON.parse(JSON.stringify(template)) as Ruleset;
  ruleset.bypass_actors = ruleset.bypass_actors.map((a) =>
    a.actor_type === "Team" ? { ...a, actor_id: opts.teamId } : a,
  );
  if (opts.scope === "org") {
    ruleset.conditions = {
      ...ruleset.conditions,
      repository_name: { include: ["~ALL"], exclude: [] },
    };
  }
  return ruleset;
}

const rule = (r: Ruleset, type: string) => r.rules.find((x) => x.type === type);

/** Everything the two rulesets must say. Checked before anything is sent to GitHub. */
export function policyProblems(protect: Ruleset, merge: Ruleset): string[] {
  const problems: string[] = [];
  if (protect.enforcement !== "active") problems.push('"Protect main" must be active');
  if (protect.bypass_actors.length > 0) problems.push('nobody may be exempt from "Protect main"');
  for (const type of ["deletion", "non_fast_forward"]) {
    if (!rule(protect, type))
      problems.push(
        `"Protect main" must block ${type === "deletion" ? "deleting main" : "force pushes"}`,
      );
  }
  const pr = rule(protect, "pull_request")?.parameters ?? {};
  if (Number(pr.required_approving_review_count ?? 0) < 1)
    problems.push("at least one approval is required");
  if (pr.require_code_owner_review !== true)
    problems.push("the approval must come from a code owner (the Pipeline approvers)");
  if (pr.require_last_push_approval !== true)
    problems.push("whoever pushed last can't be the one who approves");
  if (pr.dismiss_stale_reviews_on_push !== true)
    problems.push("new commits must clear earlier approvals");
  const checks = (
    (rule(protect, "required_status_checks")?.parameters?.required_status_checks ?? []) as {
      context: string;
    }[]
  ).map((c) => c.context);
  for (const needed of ["Checks", "Guardrails"]) {
    if (!checks.includes(needed)) problems.push(`the ${needed} job must pass before merging`);
  }

  if (merge.enforcement !== "active")
    problems.push('"Only Pipeline approvers merge" must be active');
  if (!rule(merge, "update"))
    problems.push('"Only Pipeline approvers merge" must restrict updates to main');
  const exempt = merge.bypass_actors;
  if (
    exempt.length !== 1 ||
    exempt[0]?.actor_type !== "Team" ||
    exempt[0]?.bypass_mode !== "pull_request"
  ) {
    problems.push("only the Pipeline approvers team may merge, and only through a pull request");
  }
  return problems;
}

/** The owner on CODEOWNERS' catch-all line ("*"), which GitHub asks to review every pull request. */
export function defaultCodeOwner(codeowners: string): string | undefined {
  for (const line of codeowners.split("\n")) {
    const [pattern, owner] = line.trim().split(/\s+/);
    if (pattern === "*" && owner) return owner;
  }
  return undefined;
}
