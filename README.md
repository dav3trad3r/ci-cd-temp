# CI/CD platform template (ci-cd-temp)

A starter repo for internal tools built with AI coding assistants (Claude Code, GitHub Copilot, Copilot Studio and the like). CI, security scanning and regression checks are switched on from the first commit, so a new tool starts safe without its builder having to set any of it up.

AI assistants build working apps quickly, but they rarely add pipelines, access checks or scanning unless asked. This platform makes the safe way the default. Every tool, whether it's newly built or moved from someone's private repository, gets the same checks, deploy pipeline, incident response and reporting.

## Status

A working prototype and a foundation to adapt, not a finished platform. This is what runs today:

| Part                                       | Status             | Where it stands                                                                                                                                                                                                                                             |
| ------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New tools                                  | **Working**        | `npm run tool -- new` creates a tool that passes every check. Proved from scratch on every change to the platform                                                                                                                                           |
| Migrated tools                             | **Partly proved**  | `npm run tool -- migrate` ran on copies of two real repositories and a messy test tool. Not yet moved into a real GitHub organisation                                                                                                                       |
| CI, security and regression checks         | **Working**        | Run on every pull request                                                                                                                                                                                                                                   |
| Agent rules and permissions                | **Working**        | `AGENTS.md` and `.claude/settings.json`                                                                                                                                                                                                                     |
| Guardrails check                           | **Working**        | Runs on every pull request and flags a weakened check. It becomes required to merge once the review rules are applied                                                                                                                                       |
| Nightly AI evaluation and dependency audit | **Working**        | The evaluation uses a keyword stand-in until a real model is connected                                                                                                                                                                                      |
| Azure templates                            | **Partly proved**  | Lint and compile on every pull request. The tool template has been deployed to a sandbox; the platform template has only been previewed with what-if                                                                                                        |
| Dependabot                                 | **Partly working** | Action updates work. npm updates failed on their first runs and need fixing                                                                                                                                                                                 |
| Afternoon report                           | **Not connected**  | Covers every registered tool. Its Azure checks have run read-only against a sandbox. The schedule is off, and the Teams post and AI write-up haven't run                                                                                                    |
| SRE agent                                  | **Not connected**  | Covers every registered tool. Ran end to end on a scripted incident with a planted bug ([draft PR #12](https://github.com/dav3trad3r/ci-cd-temp/pull/12)), and its fix path is tested on a migrated tool. Its Azure tools and the alert trigger haven't run |
| Review and merge rules                     | **Not applied**    | Dry-run tested. They need a GitHub organisation with a Pipeline approvers team                                                                                                                                                                              |
| Deploy pipeline                            | **Partly proved**  | Staging, promote, rollback and a blocked bad release ran on a real Azure sandbox. The whole pipeline hasn't yet run from a tool's own repository. Migrations run after approval. Staging still uses live data                                               |
| Feature map and live verification          | **Next**           | Not built: a map of each tool's features, checked against the deployed tool                                                                                                                                                                                 |

## Two ways onto the platform

Every tool ends up the same: a private repository in your organisation with the checks, deploy pipeline, code owners and agent rules, registered so the SRE agent and the afternoon report cover it.

|                           | New AI tool                   | Tool moving from a private repository      |
| ------------------------- | ----------------------------- | ------------------------------------------ |
| **Start**                 | `npm run tool -- new`         | `npm run tool -- migrate`                  |
| **Code**                  | A working starter app         | Its own code, unchanged                    |
| **First checks**          | Everything must pass          | Old problems go on a baseline to work down |
| **Secrets**               | Scanned on every pull request | Full history scanned before anything moves |
| **CI/CD, SRE, reporting** | Included                      | Included                                   |

### A new tool

```bash
npm run tool -- new --name leasing-assistant --owner jane@example.com --data Confidential --budget 5
```

This creates the tool in a sibling folder, ready to push to a new private repository, and adds it to the register in `ops/tools/`.

### A tool in someone's private repository

```bash
npm run tool -- migrate --source https://github.com/jane/leasing-tool.git \
  --name leasing-assistant --owner jane@example.com --data Confidential --budget 5
```

Without `--go` this is a dry run that changes nothing outside a local copy. It:

1. **Copies** every branch and tag. The original isn't touched.
2. **Scans the whole history for secrets** with [Gitleaks](https://github.com/gitleaks/gitleaks). If it finds any, it stops and lists where they are, never the keys themselves. Replace each key at its provider, then run it again with `--rotated <the list>`.
3. **Works out how the tool builds** (npm, pnpm, yarn or bun, and Next.js, Vite and others).
4. **Adds the platform's files** on a `platform/adopt` branch, without touching application code.
5. **Records a baseline** of what already fails.

Add `--go` (with `GITHUB_ADMIN_TOKEN`) to create the private repository, move everything and open the pull request. Once that's merged, archive the original so there's only one copy to work in.

### The baseline

| Finding                                                                    | Pull request                            | Deployment              |
| -------------------------------------------------------------------------- | --------------------------------------- | ----------------------- |
| Old lint, type, test or format problems                                    | Allowed, and the count can only go down | Allowed                 |
| A check the tool doesn't have yet                                          | Shown as a to-do                        | Allowed                 |
| **Any new problem**                                                        | **Fails**                               | Blocked                 |
| **A check that crashes or stops without a result**                         | **Fails**                               | Blocked                 |
| **An install or build that already failed**                                | Allowed, so it can be fixed             | **Blocked until fixed** |
| **Secrets in the browser, or a Supabase table without row-level security** | Allowed, so it can be fixed             | **Blocked until fixed** |
| **A secret in the git history**                                            | **Fails**                               | Blocked                 |

Lowering the baseline needs no approval. Raising it trips Guardrails and needs a person. The baseline counts problems rather than naming them, so three new test failures that replace three old ones aren't caught.

### How improvements reach every tool

Tools don't copy the checks. Each one calls the central actions in `actions/` at a pinned version.

1. Improve the platform in a pull request. The self-test proves both new and migrated tools still work.
2. Raise the version in `package.json` and add a line to `CHANGELOG.md`. Merging publishes the release.
3. Each tool's Dependabot opens a pull request for the new version, and a Pipeline approver reviews it.

If a release changes the tool's own workflow file, run `npm run tool -- update --path ../<tool>` and open a pull request.

### Set it up for your organisation

1. Put this repository in your organisation, then run `npm run tool -- setup --org your-org` and fill in the Azure values in `ops/platform.json`.
2. **This repository → Settings → Actions → General → Access:** choose "Accessible from repositories in the organization", so private tools can call the central actions.
3. Create the `pipeline-approvers` team with at least two people, and give it the **Maintain** role on each tool. Everyone else gets **Write** at most, because Maintain is what lets someone release to production.
4. Apply the review rules to every repository: `npm run rulesets:apply -- --org your-org`.
5. **Organisation variables:** `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` and `AZURE_REGISTRY`. Don't set `AZURE_CLIENT_ID` here: one shared identity would let a mistake in one pipeline reach every tool.
6. **On each tool:** create `staging` and `production` environments, each limited to the `main` branch. Deploying its Azure parameters creates two identities with no stored secrets. Set the repository variable `AZURE_CLIENT_ID` to the `buildClientId` output, and `AZURE_CLIENT_ID` in both environments to the `releaseClientId` output.

The build identity can only push that tool's image. The release identity can only change that tool's app and database job. Staging and production are revisions of one app, so they share the release identity, and the promote step is what separates them.

**GitHub plan:** rulesets on private repositories need GitHub Team or Enterprise. CodeQL and dependency review need Advanced Security: set `ADVANCED_SECURITY` to `true` once you have it. Until then, every tool still gets the Gitleaks scan and a dependency audit.

### Connect a tool to Azure

Each tool has a parameters file in `infra/tools/`. Fill in its sign-in client ID and secrets, build its first image, then create its resources once:

```bash
az group create --name rg-<tool> --location australiaeast
az deployment group create --resource-group rg-<tool> --parameters infra/tools/<tool>.bicepparam --parameters image=<registry>.azurecr.io/<tool>:<commit>
```

From then on, merging to `main` builds the image once and starts it as a **staging revision** with no live traffic. If it's unhealthy, it's switched off and live traffic never moves to it. A Pipeline approver then releases it from **Actions → Platform → Run workflow → promote**, and the step confirms they hold the Maintain role. The previous revision keeps running, so **rollback** in the same menu moves traffic back in seconds. It has its own queue, so a running deploy can't hold it up and a newer merge can't cancel it. If a rollback happens during a release, that release stops and leaves traffic where the rollback put it.

**Database changes wait for approval.** A tool's `migrate` command in `.platform/tool.json` runs once per release, as a one-off Azure job from the image being released, after approval and before traffic moves. If it fails, traffic stays where it is. The starter app no longer migrates when it boots in production, so its first promote creates its tables. On another host, run `npm run db:migrate` as the release step.

Three limits to plan around:

- **Staging uses live data.** A staging revision shares the production `DATABASE_URL`, so anyone testing that address reads and writes real records, and new code runs against the old schema until it's promoted.
- **Rollback doesn't reverse a migration.** It only moves traffic. Keep each migration compatible with the previous release: add a column first, and remove the old one in a later release.
- **A migrated tool may still change its database at startup.** Onboarding looks for this and every staging deploy warns about it until `migrate` is set and `migratesAtStartup` is false. The check looks for common migration tools, so it can miss a hand-written one.

With GitHub Enterprise you can approve inside the run instead: add required reviewers to the `production` environment and set the `PRODUCTION_GATE` variable to `environment`. The release stops if those reviewers aren't really configured.

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

Guardrails goes by what a file is, so it covers a migrated tool's own layout: its test scripts, its lint, test and type settings in any folder, skipped or deleted tests, and silenced checks. Dependabot may only move an action's version. A person can still approve an intended change with the `guardrail-change` label.

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
4. **`ops/daily-report.json`:** the shared groups to watch, the Claude model or deployment name in Foundry and the Key Vault details. Tools come from the register in `ops/tools/`, so a new or migrated tool is covered as soon as it's registered.
5. **Run it:** Actions → Daily report → Run workflow. Locally, after `az login`: `npm run report -- --dry-run`.

## Use it

```bash
npm install
npm run dev      # http://localhost:8080, with a temporary in-memory database
npm run verify   # everything CI runs, locally
```

Local runs need no set-up: without `DATABASE_URL` the server uses an in-process Postgres (PGlite) and a random signing secret. In production (`NODE_ENV=production`) it refuses to start without `APP_JWT_SECRET` and `DATABASE_URL`. See `.env.example`.

## SRE agent: incident response

Once connected, when an alert fires on a tool, `.github/workflows/incident.yml` starts the SRE agent on [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview). It investigates, keeps people updated, and proposes a fix as a draft pull request. **A person reviews and merges; the agent never changes production.** A proposed fix is tested in a locked-down Docker container with a plain copy of the commit: no credentials, no git, and no network for its tests. Only the exact commit that passed is pushed. Without Docker, the agent refuses to test a fix.

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
3. **`ops/sre-agent.json`:** the model and the spend cap per incident (`budgetUsd`). Tools come from the register in `ops/tools/`. Set each tool's Log Analytics workspace ID and reviewer in its register entry. The agent clones the tool's repository for the incident and tests any fix with that tool's own commands and baseline, with no pipeline credentials.
4. **The alert:** in the action group, call a Logic App that posts to `https://api.github.com/repos/<owner>/<repo>/dispatches` with `{"event_type": "azure-alert", "client_payload": {"tool": "<tool>", "alert": "<alert id>"}}`.
5. **Setup:** `npm run sre:setup` creates the agent, its sandbox, the runbook skill and both memory stores, and records their IDs in `ops/sre-agent.lock.json`. Commit that file so the workflow reuses them; the IDs are useless without the API key. Run setup again after changing the agent's files, and in a copy of this template, delete the file first so setup creates resources in your own account.

Managed Agents runs on Anthropic's platform. On Microsoft Foundry, the same tools and runbook fit Foundry Agent Service.

## Switch these on in the repository's settings

Some protections are repository settings rather than files:

1. **Settings → Actions → General → Access:** let repositories in the organisation use this repository's actions.
2. **Settings → Advanced Security:** turn on secret scanning and **push protection**, which blocks a commit that contains a key.
3. **A Pipeline approvers team:** in the organisation, create a `pipeline-approvers` team with at least two people, so merging never depends on one person. Make it the reviewer for every pull request in `.github/CODEOWNERS` (`* @your-org/pipeline-approvers`).
4. **The review and merge rules:** `.github/rulesets/` holds two rulesets for `main`. Check them with `npm run rulesets:apply -- --org your-org --dry-run`, then apply them with an organisation admin token in `GITHUB_ADMIN_TOKEN`: without `--repo` they cover every repository in the organisation, and `--repo <name>` applies them to one. If the organisation's plan doesn't offer organisation-wide rulesets, apply them per repository.
   - **Protect main:** a pull request; an approval from a code owner who isn't the last person to push; fresh approval after new commits; review threads resolved; the **Checks** and **Guardrails** jobs passing; no force pushes or deletion. Nobody is exempt.
   - **Only Pipeline approvers merge:** nobody else can update `main`, and the team can only do it through a pull request. Being exempt from this ruleset doesn't exempt them from Protect main, so their own changes still need someone else's approval.
5. **Issues → Labels:** create the `guardrail-change` label, used to approve an intended change to the checks.

## Before production

- **Sign-in:** replace the template's signed tokens with your organisation's identity provider, such as Microsoft Entra ID (`src/server/auth.ts` explains where).
- **Secrets:** keep `APP_JWT_SECRET` and `DATABASE_URL` in your host's secret store (Azure Key Vault, Railway variables), never in the repo.
- **Deploy:** use the deploy stage above, so only commits where the checks passed can reach production.

## Stack

Node 22 and TypeScript, [Hono](https://hono.dev) for the API, [Zod](https://zod.dev) for input validation, Postgres (`pg` in production, [PGlite](https://pglite.dev) in tests and local runs), [Vite](https://vite.dev) for the browser build, and [Vitest](https://vitest.dev) for tests.

## Licence

MIT. See `LICENSE`.
