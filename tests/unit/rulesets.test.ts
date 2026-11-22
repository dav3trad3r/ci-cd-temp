import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  defaultCodeOwner,
  forScope,
  policyProblems,
  type Ruleset,
} from "../../scripts/rulesets.js";

const load = (file: string) =>
  JSON.parse(readFileSync(`.github/rulesets/${file}`, "utf8")) as Ruleset;
const protect = load("protect-main.json");
const merge = load("only-pipeline-approvers-merge.json");

describe("review and merge rules for main", () => {
  test("the rulesets in the repository meet the policy", () => {
    expect(policyProblems(protect, merge)).toEqual([]);
  });

  test("every pull request needs a code owner's approval, and checks that pass", () => {
    const pr = protect.rules.find((r) => r.type === "pull_request")?.parameters;
    expect(pr).toMatchObject({
      required_approving_review_count: 1,
      require_code_owner_review: true,
      require_last_push_approval: true,
      dismiss_stale_reviews_on_push: true,
    });
    expect(protect.bypass_actors).toEqual([]);
  });

  test("only the Pipeline approvers team can update main, and only through a pull request", () => {
    const ruleset = forScope(merge, { teamId: 4242, scope: "repo" });
    expect(ruleset.bypass_actors).toEqual([
      { actor_type: "Team", actor_id: 4242, bypass_mode: "pull_request" },
    ]);
    expect(ruleset.rules.map((r) => r.type)).toEqual(["update"]);
  });

  test("an organisation-wide ruleset covers every repository", () => {
    expect(forScope(protect, { teamId: 1, scope: "org" }).conditions.repository_name).toEqual({
      include: ["~ALL"],
      exclude: [],
    });
    expect(
      forScope(protect, { teamId: 1, scope: "repo" }).conditions.repository_name,
    ).toBeUndefined();
  });

  test("weakening either ruleset is caught before anything is sent to GitHub", () => {
    const weak = JSON.parse(JSON.stringify(protect)) as Ruleset;
    weak.bypass_actors = [
      { actor_type: "OrganizationAdmin", actor_id: null, bypass_mode: "always" },
    ];
    const pr = weak.rules.find((r) => r.type === "pull_request");
    if (pr?.parameters) pr.parameters.require_last_push_approval = false;
    const open = JSON.parse(JSON.stringify(merge)) as Ruleset;
    open.bypass_actors = [];
    expect(policyProblems(weak, open)).toEqual([
      'nobody may be exempt from "Protect main"',
      "whoever pushed last can't be the one who approves",
      "only the Pipeline approvers team may merge, and only through a pull request",
    ]);
  });

  test("CODEOWNERS names a reviewer for every pull request", () => {
    expect(defaultCodeOwner("# comment\n*   @place/pipeline-approvers\n/db/  @place/data\n")).toBe(
      "@place/pipeline-approvers",
    );
    expect(defaultCodeOwner(readFileSync(".github/CODEOWNERS", "utf8"))).toBeDefined();
  });

  test("agents can't merge, approve or change the rules", () => {
    const settings = JSON.parse(readFileSync(".claude/settings.json", "utf8")) as {
      permissions: { deny: string[] };
    };
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining([
        "Bash(gh pr merge *)",
        "Bash(gh pr review *--approve*)",
        "Bash(gh api *rulesets*)",
        "Bash(npm run rulesets:apply *)",
      ]),
    );
  });
});
