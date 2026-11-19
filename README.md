# CI/CD template (ci-cd-temp)

A starter repo for internal tools built with AI coding assistants (Claude Code, GitHub Copilot, Copilot Studio and the like). CI, security scanning and regression checks are switched on from the first commit, so a new tool starts safe without its builder having to set any of it up.

AI assistants build working apps quickly, but they rarely add pipelines, access checks or scanning unless asked. This template makes the safe way the default: click **Use this template**, build your tool, and every pull request is checked before it can reach production.

## What runs, and when

| Layer          | Check                                                                         | When                       |
| -------------- | ----------------------------------------------------------------------------- | -------------------------- |
| Hygiene        | Install from the lockfile, format, lint, type check, build                    | Every pull request         |
| Security       | Access tests: no sign-in gets 401, another user's data gets 404               | Every pull request         |
|                | Row-level security switched on for every table                                | Every pull request         |
|                | No secrets in the browser bundle, no secret-like `VITE_` variables            | Every pull request         |
|                | Dependency review (blocks packages with known high-severity issues)           | Every pull request         |
|                | CodeQL code scanning                                                          | Every pull request, weekly |
|                | Dependabot updates for packages and pinned actions                            | Weekly                     |
| Regression     | A test for every fixed bug (`tests/regressions/`)                             | Every pull request         |
|                | API contract snapshots: response shapes cannot change by accident             | Every pull request         |
|                | Bundle-size budget for browser JavaScript (`budgets.json`)                    | Every pull request         |
|                | AI evaluation: known-answer cases must meet the baseline (`evals/`)           | Nightly                    |
| AI agents      | Guardrails: no check weakened (skipped tests, raised budgets, edited CI)      | Every pull request         |
| Infrastructure | Azure templates in `infra/` pass the Bicep linter and compile                 | Every pull request         |
| Running app    | Smoke test: the built server starts, answers, and refuses anonymous API calls | Every pull request         |
| Supply chain   | Production dependency audit                                                   | Nightly                    |

Every pull request finishes in a few minutes. Slow or costly checks run nightly so they never hold up a change.

## The three checks that catch AI-code mistakes

1. **Access tests** (`tests/security/access.test.ts`). AI-written APIs often ship a route that works without signing in, or that lets one user read another's records. Copy a test for every route you add.
2. **No table without row-level security** (`tests/security/rls.test.ts`). Applies every migration to a fresh Postgres and fails if any table is missing RLS. This is the common Supabase leak, where anyone holding the public key can read a table.
3. **No secrets in the front end** (`scripts/check-frontend.mjs`). Fails the build if the browser bundle contains a live key or a server setting, or if a `VITE_` variable is named like a secret. Anything prefixed `VITE_` or `NEXT_PUBLIC_` is readable by every visitor.

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
- edits the workflows, `CODEOWNERS`, agent settings, `AGENTS.md` or the test, lint and type-check configuration (Dependabot's action bumps are let through)

`npm run check:guardrails` shows locally what a reviewer will be asked to approve.

**Know the limits.** Each layer can be worked around on its own, which is why there are three, with branch protection behind them:

- `AGENTS.md` is guidance. Agents follow it most of the time, not always.
- Agent permission rules stop the usual form of a command, not every way of writing it.
- The Guardrails check runs from the pull request's own copy of the workflow, so a pull request could edit it away. That edit is itself flagged and visible in review; for full strength, require code-owner review of `.github/` (see below), which needs a second person.

### Skills

`.claude/skills/` gives Claude Code six skills. The first five run only when someone types them.

| Type            | What it does                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/how`          | Explains how a part of the tool works, before you change it                                                                                      |
| `/why`          | Explains why it was built that way, from the commits and pull requests                                                                           |
| `/teach`        | Combines `how` and `why` into one plain explanation for someone new to the code                                                                  |
| `/tdd`          | Fixes a bug by writing the failing test first, in `tests/regressions/`                                                                           |
| `/blast-radius` | Finds what a change could break elsewhere, and proves the fact it is safe because of by running code                                             |
| `/unslop`       | Turns an AI-looking screen into a designed one. It also starts when someone asks to polish a screen, and shows its plan before changing anything |

`how`, `why`, `teach`, `tdd` and `blast-radius` come from [pstack](https://github.com/backnotprop/pstack) (MIT licence), with notes for this repo added. `unslop` is by Damir Sokolovsky ([heydamir.design/unslop](https://heydamir.design/unslop)), unchanged, under CC BY 4.0, which asks that the credit stays in every copy. Each folder keeps its licence. The lint and format checks skip `.claude/skills/` so the files stay as their authors wrote them; changes to them still need the `guardrail-change` label, like everything under `.claude/`.

**Outside the repo**, give each agent its own identity with the least access it needs: read-only by default, never a person's login, and short-lived credentials (such as GitHub's OIDC sign-in to the cloud) instead of stored keys. Your cloud's activity log then shows which agent changed what.

## Deploy to Azure

`infra/` holds Bicep templates (Azure's infrastructure-as-code language) for running a tool on Azure Container Apps the standard way: Entra sign-in, its own identity and Key Vault, scale to zero, logs and alerts to the platform team, and owner, cost-centre and data-classification tags. See [infra/README.md](infra/README.md).

## Use it

```bash
npm install
npm run dev      # http://localhost:8080, with a temporary in-memory database
npm run verify   # everything CI runs, locally
```

Local runs need no set-up: without `DATABASE_URL` the server uses an in-process Postgres (PGlite) and a random signing secret. In production (`NODE_ENV=production`) it refuses to start without `APP_JWT_SECRET` and `DATABASE_URL`. See `.env.example`.

## Switch these on in the repository's settings

Some protections are repository settings rather than files:

1. **Settings → General:** tick **Template repository**, so people can start new tools from it.
2. **Settings → Advanced Security:** turn on secret scanning and **push protection**, which blocks a commit that contains a key.
3. **Settings → Rules → Rulesets:** for `main`, require a pull request and require the **Checks** and **Guardrails** status checks to pass before merging.
4. **Issues → Labels:** create the `guardrail-change` label, used to approve an intended change to the checks.
5. **For teams:** in the same ruleset, tick **Require review from Code Owners**, so changes to `.github/` and the migrations need the owners in `.github/CODEOWNERS` to approve them.

## Before production

- **Sign-in:** replace the template's signed tokens with your organisation's identity provider, such as Microsoft Entra ID (`src/server/auth.ts` explains where).
- **Secrets:** keep `APP_JWT_SECRET` and `DATABASE_URL` in your host's secret store (Azure Key Vault, Railway variables), never in the repo.
- **Deploy:** connect your host to this repo, and only deploy commits where CI passed.

## Stack

Node 22 and TypeScript, [Hono](https://hono.dev) for the API, [Zod](https://zod.dev) for input validation, Postgres (`pg` in production, [PGlite](https://pglite.dev) in tests and local runs), [Vite](https://vite.dev) for the browser build, and [Vitest](https://vitest.dev) for tests.

## Licence

MIT. See `LICENSE`.
