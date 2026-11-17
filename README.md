# CI/CD template (ci-cd-temp)

A starter repo for internal tools built with AI coding assistants (Claude Code, GitHub Copilot, Copilot Studio and the like). CI, security scanning and regression checks are switched on from the first commit, so a new tool starts safe without its builder having to set any of it up.

AI assistants build working apps quickly, but they rarely add pipelines, access checks or scanning unless asked. This template makes the safe way the default: click **Use this template**, build your tool, and every pull request is checked before it can reach production.

## What runs, and when

| Layer        | Check                                                                         | When                       |
| ------------ | ----------------------------------------------------------------------------- | -------------------------- |
| Hygiene      | Install from the lockfile, format, lint, type check, build                    | Every pull request         |
| Security     | Access tests: no sign-in gets 401, another user's data gets 404               | Every pull request         |
|              | Row-level security switched on for every table                                | Every pull request         |
|              | No secrets in the browser bundle, no secret-like `VITE_` variables            | Every pull request         |
|              | Dependency review (blocks packages with known high-severity issues)           | Every pull request         |
|              | CodeQL code scanning                                                          | Every pull request, weekly |
|              | Dependabot updates for packages and pinned actions                            | Weekly                     |
| Regression   | A test for every fixed bug (`tests/regressions/`)                             | Every pull request         |
|              | API contract snapshots: response shapes cannot change by accident             | Every pull request         |
|              | Bundle-size budget for browser JavaScript (`budgets.json`)                    | Every pull request         |
|              | AI evaluation: known-answer cases must meet the baseline (`evals/`)           | Nightly                    |
| Running app  | Smoke test: the built server starts, answers, and refuses anonymous API calls | Every pull request         |
| Supply chain | Production dependency audit                                                   | Nightly                    |

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
3. **Settings → Rules → Rulesets:** for `main`, require a pull request and require the **Checks** status check to pass before merging.

## Before production

- **Sign-in:** replace the template's signed tokens with your organisation's identity provider, such as Microsoft Entra ID (`src/server/auth.ts` explains where).
- **Secrets:** keep `APP_JWT_SECRET` and `DATABASE_URL` in your host's secret store (Azure Key Vault, Railway variables), never in the repo.
- **Deploy:** connect your host to this repo, and only deploy commits where CI passed.

## Stack

Node 22 and TypeScript, [Hono](https://hono.dev) for the API, [Zod](https://zod.dev) for input validation, Postgres (`pg` in production, [PGlite](https://pglite.dev) in tests and local runs), [Vite](https://vite.dev) for the browser build, and [Vitest](https://vitest.dev) for tests.

## Licence

MIT. See `LICENSE`.
