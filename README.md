# CI/CD template (ci-cd-temp)

A starter repo for internal tools built with AI coding assistants (Claude Code, GitHub Copilot, Copilot Studio and the like). CI, security scanning and regression checks are switched on from the first commit, so a new tool starts safe without its builder having to set any of it up.

AI assistants build working apps quickly, but they rarely add pipelines, access checks or scanning unless asked. This template makes the safe way the default: click **Use this template**, build your tool, and every pull request is checked before it can reach production.

## Status

A working prototype and a foundation to adapt, not a finished platform. This is what runs today:

| Part                                       | Status             | Where it stands                                                                                                                                                                                                                  |
| ------------------------------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI, security and regression checks         | **Working**        | Run on every pull request                                                                                                                                                                                                        |
| Agent rules and permissions                | **Working**        | `AGENTS.md` and `.claude/settings.json`                                                                                                                                                                                          |
| Guardrails check                           | **Working**        | Runs on every pull request and flags a weakened check. It becomes required to merge once the review rules are applied                                                                                                            |
| Nightly AI evaluation and dependency audit | **Working**        | The evaluation uses a keyword stand-in until a real model is connected                                                                                                                                                           |
| Azure templates                            | **Partly proved**  | Lint and compile on every pull request. The tool template has been deployed to a sandbox; the platform template has only been previewed with what-if                                                                             |
| Dependabot                                 | **Partly working** | Action updates work. npm updates failed on their first runs and need fixing                                                                                                                                                      |
| Afternoon report                           | **Not connected**  | Its Azure checks have run read-only against a sandbox. The schedule is off, and the Teams post and AI write-up haven't run                                                                                                       |
| SRE agent                                  | **Not connected**  | Ran end to end on a scripted incident with a planted bug ([draft PR #12](https://github.com/dav3trad3r/ci-cd-temp/pull/12)). Its Azure tools, the alert trigger and opening pull requests directly from the workflow haven't run |
| Review and merge rules                     | **Not applied**    | Dry-run tested. They need a GitHub organisation with a Pipeline approvers team                                                                                                                                                   |
| Deploy pipeline                            | **Next**           | Not built: build once, deploy to staging, verify, promote, roll back                                                                                                                                                             |
| Feature map and live verification          | **Next**           | Not built: a map of each tool's features, checked against the deployed tool                                                                                                                                                      |

## What runs, and when

| Layer          | Check                                                                             | When                             |
| -------------- | --------------------------------------------------------------------------------- | -------------------------------- |
| Hygiene        | Install from the lockfile, format, lint, type check, build                        | Every pull request               |
| Security       | Access tests: no sign-in gets 401, another user's data gets 404                   | Every pull request               |
|                | Row-level security switched on for every table                                    | Every pull request               |
|                | No secrets in the browser bundle, no secret-like `VITE_` or `NEXT_PUBLIC_` names  | Every pull request               |
|                | Dependency review (blocks packages with known high-severity issues)               | Every pull request               |
|                | CodeQL code scanning                                                              | Every pull request, weekly       |
|                | Dependabot updates for packages and pinned actions                                | Weekly                           |
| Regression     | A test for every fixed bug (`tests/regressions/`)                                 | Every pull request               |
|                | API contract snapshots: response shapes cannot change by accident                 | Every pull request               |
|                | Bundle-size budget for browser JavaScript (`budgets.json`)                        | Every pull request               |
|                | AI evaluation: known-answer cases must meet the baseline (`evals/`)               | Nightly                          |
| AI agents      | Guardrails: no check weakened (skipped tests, raised budgets, edited CI)          | Every pull request               |
|                | SRE agent: investigates an alert, proposes a fix as a draft pull request          | On an alert, once connected      |
| Review         | A Pipeline approver approves; only Pipeline approvers merge (`.github/rulesets/`) | Every pull request, once applied |
| Infrastructure | Azure templates in `infra/` pass the Bicep linter and compile                     | Every pull request               |
| Running app    | Smoke test: the built server starts, answers, and refuses anonymous API calls     | Every pull request               |
| Supply chain   | Production dependency audit                                                       | Nightly                          |
| Operations     | Afternoon report: drift, changes, alerts, spend and what shipped, to Teams        | Weekdays 3 pm, once connected    |

Every pull request finishes in a few minutes. Slow or costly checks run nightly so they never hold up a change.

## The three checks that catch AI-code mistakes

1. **Access tests** (`tests/security/access.test.ts`). AI-written APIs often ship a route that works without signing in, or that lets one user read another's records. Copy a test for every route you add.
2. **No table without row-level security** (`tests/security/rls.test.ts`). Applies every migration to a fresh Postgres and fails if any table is missing RLS. This is the common Supabase leak, where anyone holding the public key can read a table.
3. **No secrets in the front end** (`scripts/check-frontend.mjs`). Fails the build if the browser bundle contains a live key (Stripe, Supabase, Anthropic, OpenAI, AWS, GitHub, Slack) or a server setting, or if a `VITE_` or `NEXT_PUBLIC_` variable is named like a secret: anything with those prefixes is readable by every visitor. It also decodes every JWT in the bundle, so a Supabase service-role key fails the build whatever it was named; the public anon key is allowed.

## Regression checks

- **Bug-fix tests:** every fixed bug gets a dated test in `tests/regressions/` that failed before the fix. See the folder's README for the convention.
- **API contract snapshots:** `tests/regressions/api-contract.test.ts` fails if a response's shape changes. If the change is intended, run `npx vitest run -u` and commit the new snapshot with it.
- **Bundle-size budget:** browser JavaScript must stay under `budgets.json`. Raise the budget on purpose in a pull request, never just to make CI pass.
- **AI evaluation baseline:** `npm run eval` runs the cases in `evals/cases.json` and fails below `evals/baseline.json`. The template's classifier is a keyword stand-in so it runs with no API key; replace it with your model call and the evaluation tells you whether a prompt or model change made results better or worse.

## Working with AI agents

AI coding agents work fast and sound sure of themselves, and when a check fails, the quickest way to a green build is to weaken the check: skip the failing test, raise the budget, silence the linter or edit the workflow. The template guards against that in three layers.

| Layer             | File                                                              | What it does                                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rules             | `AGENTS.md` (Claude Code reads it through `CLAUDE.md`)            | Tells every agent how changes reach `main`, which tests each change needs, how to treat secrets, and when to stop and ask a person.                                                           |
| Agent permissions | `.claude/settings.json`                                           | Claude Code can't read `.env` files, force-push, push to `main` or delete cloud resources, and asks before other pushes, package installs and edits to the check configuration.               |
| Guardrails check  | `scripts/check-guardrails.ts`, `.github/workflows/guardrails.yml` | Fails a pull request that weakens a check. A person approves an intended change by adding the `guardrail-change` label, which leaves a visible record of who approved it on the pull request. |

The Guardrails check fails a pull request that:

- adds `.skip`, `.only` or `.todo` to a test, or deletes a test in `tests/security/` or `tests/regressions/`
- adds `eslint-disable`, `@ts-ignore` or `@ts-nocheck`
- raises a number in `budgets.json` or lowers `evals/baseline.json`
- changes a check script in `package.json` (such as `test` or `lint`)
- edits the workflows, `CODEOWNERS`, agent settings, `AGENTS.md`, the scripts that run the checks, or the test, lint, format and type-check configuration (Dependabot's action bumps are let through)

`npm run check:guardrails` shows locally what a reviewer will be asked to approve.

**Know the limits.** Each layer can be worked around on its own, which is why there are three, with branch protection behind them:

- `AGENTS.md` is guidance. Agents follow it most of the time, not always.
- Agent permission rules stop the usual form of a command, not every way of writing it.
- The Guardrails check runs from the pull request's own copy of the workflow, so a pull request could edit it away. That edit is itself flagged and visible in review; for full strength, require code-owner review of `.github/` (see below), which needs a second person.

### Skills

`.claude/skills/` gives Claude Code five skills, which run only when someone types them.

| Type            | What it does                                                                         |
| --------------- | ------------------------------------------------------------------------------------ |
| `/how`          | Explains how a part of the tool works, before you change it                          |
| `/why`          | Explains why it was built that way, from the commits and pull requests               |
| `/teach`        | Combines `how` and `why` into one plain explanation for someone new to the code      |
| `/tdd`          | Fixes a bug by writing the failing test first, in `tests/regressions/`               |
| `/blast-radius` | Finds what a change could break elsewhere, and runs code to prove the change is safe |

`how`, `why`, `teach`, `tdd` and `blast-radius` come from [pstack](https://github.com/backnotprop/pstack) (MIT licence), with notes for this repo added. Each folder keeps its licence. The lint and format checks skip `.claude/skills/` so the files stay close to the originals and easy to update; changes to them still need the `guardrail-change` label, like everything under `.claude/`.

**Outside the repo**, give each agent its own identity with the least access it needs: read-only by default, never a person's login, and short-lived credentials (such as GitHub's OIDC sign-in to the cloud) instead of stored keys. Your cloud's activity log then shows which agent changed what.

## Deploy to Azure

`infra/` holds Bicep templates (Azure's infrastructure-as-code language) for running a tool on Azure Container Apps the standard way: Entra sign-in, its own identity and Key Vault, scale to zero, logs and alerts to the platform team, and owner, cost-centre and data-classification tags. See [infra/README.md](infra/README.md).

## Afternoon platform report

Once connected, every weekday at 3 pm Brisbane time, `.github/workflows/daily-report.yml` posts a short report to a Teams channel for tool owners and the people they report to. Scripts gather the facts with read-only access, an agent (Claude on Microsoft Foundry) writes them up in plain English, and people decide what to do.

| It checks                    | How                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| Drift                        | Bicep what-if for each tool: settings changed outside the code, resources missing          |
| Resources made outside code  | Azure Resource Graph: anything in a watched group without the `managed-by: bicep` tag      |
| Changes in the last 24 hours | Azure Resource Graph: what changed, who changed it, and from where (portal, CLI, pipeline) |
| Alerts                       | Azure Monitor alerts that started in the last 24 hours, matched to each tool               |
| Yesterday's spend            | Azure Cost Management, per tool through the `tool` tag, against each tool's daily budget   |
| What shipped                 | Pull requests merged in the last 24 hours, with guardrail exceptions marked                |

Anything that needs a person comes first: drift, hand-made resources, a tool over budget, a severe alert still open. A check that couldn't run is named, never hidden. If the agent isn't set up, fails or declines, the plain report goes out instead, so the report always arrives and is always right. The report can't change anything: its identity can only read.

**Try it now:** `npm run report:sample` prints the report from example data, with no Azure needed. `npm run report:sample -- --post` sends that example to Teams, to test the webhook.

**Plug it in:**

1. **A read-only Azure identity.** Create an app registration (or user-assigned managed identity) for the report and add a federated credential for GitHub Actions: this repository, branch `main` (scheduled runs use the default branch). Give it:
   - **Reader** and **Cost Management Reader** on the subscription.
   - A custom role on each tool's resource group with `Microsoft.Resources/deployments/*`, which what-if needs. It still can't change a resource: Azure checks the identity's own rights on each one, and those are read-only.
   - For the agent, either **Key Vault Secrets User** on the vault holding the Foundry key, or (with `"auth": "entra"`, no key at all) a role that can call the Foundry resource's models, such as **Azure AI User**.
2. **Repository variables:** `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` and `ANTHROPIC_FOUNDRY_RESOURCE` (the Foundry resource name). The workflow does nothing until `AZURE_CLIENT_ID` is set.
3. **Repository secrets:** `TEAMS_WEBHOOK_URL`, from a Teams channel's Workflows ("Post to a channel when a webhook request is received"). Optional: `ANTHROPIC_FOUNDRY_API_KEY` if the key isn't in Key Vault, and `REPORT_GITHUB_TOKEN`, a read-only token, to report on every repository in the organisation.
4. **`ops/daily-report.json`:** one entry per tool (name, owner, resource group, parameters file, daily budget), the shared groups to watch, the Claude model or deployment name in Foundry, the Key Vault holding its key, and the GitHub search (for example `org:your-org`).
5. **Run it:** Actions → Daily report → Run workflow. Locally, after `az login`: `npm run report -- --dry-run`.

## Use it

```bash
npm install
npm run dev      # http://localhost:8080, with a temporary in-memory database
npm run verify   # everything CI runs, locally
```

Local runs need no set-up: without `DATABASE_URL` the server uses an in-process Postgres (PGlite) and a random signing secret. In production (`NODE_ENV=production`) it refuses to start without `APP_JWT_SECRET` and `DATABASE_URL`. See `.env.example`.

## SRE agent: incident response

Once connected, when an alert fires on a tool, `.github/workflows/incident.yml` starts the SRE agent on [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview). It investigates, keeps people updated, and proposes a fix as a draft pull request. **A person reviews and merges; the agent never changes production.**

1. **The alert starts it.** An Azure Monitor action group calls a Logic App, which calls GitHub's `repository_dispatch` with the tool and the alert.
2. **It investigates with read-only tools** that this workflow runs for it: `get_alert`, `get_metrics` (Azure Monitor), `get_logs` (Log Analytics), `get_recent_deploys` (container app revisions) and `get_diff` (GitHub). It follows a runbook skill (`sre/agent/runbook/`), reads team memory (the service map, known noise, past incidents) and keeps its own notebook between incidents.
3. **It reads and tests the code** in its own sandbox: a snapshot of the deployed branch, with no internet except package registries and no credentials.
4. **It posts updates** for the tool's owner (`post_update`, to Teams).
5. **It proposes a fix** (`propose_fix`): a revert when the suspect deploy is one small change, or else the smallest code fix plus a dated regression test. This workflow, not the agent, applies it in a clean copy of the repository, runs the Guardrails rules, lint, types and tests, and only then pushes an `sre-agent/` branch and opens a **draft** pull request, which runs CI like any other.
6. **It records a post-mortem** in the team's format, and a note for the next incident.

| The agent can                                 | The agent can't                                              |
| --------------------------------------------- | ------------------------------------------------------------ |
| Read alerts, metrics, logs, deploys and diffs | Hold any credential: GitHub and Azure calls run outside it   |
| Run the code's tests in its sandbox           | Change workflows, agent settings, budgets, baselines, checks |
| Propose a fix (confidence of 70% or more)     | Add dependencies, push to main, merge or deploy              |
| Write to its own notebook                     | Change the team's memory, or spend past its budget           |

**Try the demo:** `npm run sre:setup` once, then `npm run sre:demo`. The `sre-demo` branch carries a planted bug: a new route with a column-name typo, which passes every existing test because the route has none. The demo incident (`sre/demo/incident.json`) scripts the alert, metrics and logs; the deploy record, diff and code come from the real branch.

**Plug it in:**

1. **Secrets:** `ANTHROPIC_API_KEY`; `SRE_AGENT_GITHUB_TOKEN`, a fine-grained token (or GitHub App) with contents and pull requests write on the tools' repositories, without which the agent diagnoses only; and `TEAMS_WEBHOOK_URL`.
2. **Azure:** the read-only identity from the afternoon report, plus **Monitoring Reader** and **Log Analytics Reader**. Repository variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` and `SRE_AGENT_ENABLED=true`.
3. **`ops/sre-agent.json`:** one entry per tool (repository, base branch, resource group, container app, Log Analytics workspace ID, reviewer), the model, and the spend cap per incident (`budgetUsd`, enforced by Managed Agents).
4. **The alert:** in the action group, call a Logic App that posts to `https://api.github.com/repos/<owner>/<repo>/dispatches` with `{"event_type": "azure-alert", "client_payload": {"tool": "<tool>", "alert": "<alert id>"}}`.
5. **Setup:** `npm run sre:setup` creates the agent, its sandbox, the runbook skill and both memory stores, and records their IDs in `ops/sre-agent.lock.json`. Commit that file so the workflow reuses them; the IDs are useless without the API key. Run setup again after changing the agent's files, and in a copy of this template, delete the file first so setup creates resources in your own account.

Managed Agents runs on Anthropic's platform. On Microsoft Foundry, the same tools and runbook fit Foundry Agent Service.

## Switch these on in the repository's settings

Some protections are repository settings rather than files:

1. **Settings → General:** tick **Template repository**, so people can start new tools from it.
2. **Settings → Advanced Security:** turn on secret scanning and **push protection**, which blocks a commit that contains a key.
3. **A Pipeline approvers team:** in the organisation, create a `pipeline-approvers` team with at least two people, so merging never depends on one person. Make it the reviewer for every pull request in `.github/CODEOWNERS` (`* @your-org/pipeline-approvers`).
4. **The review and merge rules:** `.github/rulesets/` holds two rulesets for `main`. Check them with `npm run rulesets:apply -- --org your-org --dry-run`, then apply them with an organisation admin token in `GITHUB_ADMIN_TOKEN`: without `--repo` they cover every repository in the organisation, and `--repo <name>` applies them to one. If the organisation's plan doesn't offer organisation-wide rulesets, apply them per repository.
   - **Protect main:** a pull request; an approval from a code owner who isn't the last person to push; fresh approval after new commits; review threads resolved; the **Checks** and **Guardrails** jobs passing; no force pushes or deletion. Nobody is exempt.
   - **Only Pipeline approvers merge:** nobody else can update `main`, and the team can only do it through a pull request. Being exempt from this ruleset doesn't exempt them from Protect main, so their own changes still need someone else's approval.
5. **Issues → Labels:** create the `guardrail-change` label, used to approve an intended change to the checks.

## Before production

- **Sign-in:** replace the template's signed tokens with your organisation's identity provider, such as Microsoft Entra ID (`src/server/auth.ts` explains where).
- **Secrets:** keep `APP_JWT_SECRET` and `DATABASE_URL` in your host's secret store (Azure Key Vault, Railway variables), never in the repo.
- **Deploy:** connect your host to this repo, and only deploy commits where CI passed.

## Stack

Node 22 and TypeScript, [Hono](https://hono.dev) for the API, [Zod](https://zod.dev) for input validation, Postgres (`pg` in production, [PGlite](https://pglite.dev) in tests and local runs), [Vite](https://vite.dev) for the browser build, and [Vitest](https://vitest.dev) for tests.

## Licence

MIT. See `LICENSE`.
