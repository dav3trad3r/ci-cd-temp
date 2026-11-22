// Applies the review and merge rules in .github/rulesets/ to Place's GitHub organisation.
//   npm run rulesets:apply -- --org place --dry-run                  show what would be sent
//   npm run rulesets:apply -- --org place                            every repository in the organisation
//   npm run rulesets:apply -- --org place --repo leasing-assistant   one repository
// Options: --team <slug> (default pipeline-approvers). Needs GITHUB_ADMIN_TOKEN: an organisation
// admin token (or a repository admin token with --repo). Running it again updates the rulesets.
import { readFileSync } from "node:fs";
import { defaultCodeOwner, forScope, policyProblems, type Ruleset } from "./rulesets.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const org = flag("--org");
const team = flag("--team") ?? "pipeline-approvers";
const repo = flag("--repo");
const dryRun = args.includes("--dry-run");
if (!org) throw new Error("Give the organisation: --org <name>.");

const load = (file: string) =>
  JSON.parse(readFileSync(`.github/rulesets/${file}`, "utf8")) as Ruleset;
const protect = load("protect-main.json");
const merge = load("only-pipeline-approvers-merge.json");

const problems = policyProblems(protect, merge);
if (problems.length)
  throw new Error(`The rulesets don't match the policy:\n- ${problems.join("\n- ")}`);

const owner = defaultCodeOwner(readFileSync(".github/CODEOWNERS", "utf8"));
if (owner !== `@${org}/${team}`) {
  console.warn(
    `Note: .github/CODEOWNERS asks ${owner ?? "nobody"} to review every pull request. Set "* @${org}/${team}" so the Pipeline approvers are asked automatically.`,
  );
}

const token = process.env.GITHUB_ADMIN_TOKEN;
async function github(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ci-cd-temp-rulesets",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as { message?: string };
  if (!response.ok)
    throw new Error(`${method} ${path}: GitHub answered ${response.status} ${data.message ?? ""}`);
  return data;
}

const scope = repo ? "repo" : "org";
const base = repo ? `/repos/${org}/${repo}/rulesets` : `/orgs/${org}/rulesets`;

if (dryRun) {
  for (const template of [protect, merge]) {
    console.log(`Would apply "${template.name}" at ${base}:`);
    console.log(JSON.stringify(forScope(template, { teamId: 0, scope }), null, 2));
  }
  console.log(`(The ${team} team's ID replaces actor_id 0 when this runs for real.)`);
} else {
  if (!token)
    throw new Error("Set GITHUB_ADMIN_TOKEN to an admin token for the organisation or repository.");
  const { id: teamId } = (await github("GET", `/orgs/${org}/teams/${team}`)) as { id: number };
  const existing = (await github("GET", base)) as { id: number; name: string }[];
  for (const template of [protect, merge]) {
    const ruleset = forScope(template, { teamId, scope });
    const current = existing.find((r) => r.name === ruleset.name);
    if (current) {
      await github("PUT", `${base}/${current.id}`, ruleset);
      console.log(`Updated "${ruleset.name}".`);
    } else {
      await github("POST", base, ruleset);
      console.log(`Created "${ruleset.name}".`);
    }
  }
}
