# Instructions for AI coding agents

These rules apply to any coding agent working in this repository (Claude Code, GitHub Copilot, Codex, Cursor and others), and to people.

## How changes reach `main`

- Work on a branch and open a pull request. Never push to `main`: it is protected, and the push will be refused.
- Run `npm run verify` before opening a pull request. It runs everything CI runs.
- Keep each pull request to one change, and say in the description what changed and why.

## Fix the code, never the check

CI exists to catch mistakes, including yours. When a check fails, fix the code. Don't:

- skip, focus or delete tests (`.skip`, `.only`, `.todo`), or delete anything in `tests/security/` or `tests/regressions/`
- silence the linter or type checker (`eslint-disable`, `@ts-ignore`, `@ts-nocheck`)
- raise `budgets.json`, lower `evals/baseline.json`, or change the check scripts in `package.json`
- edit the workflows, `.claude/`, this file or the test and lint configuration, unless that is the task

The **Guardrails** check fails a pull request that does any of these. If such a change is truly intended, explain why in the pull request description. A person approves it by adding the `guardrail-change` label; never add that label yourself.

## Tests that come with every change

- **New API route:** add an access test (no sign-in gets 401, another user's item gets 404), like `tests/security/access.test.ts`.
- **New table:** switch on row-level security in its migration. `tests/security/rls.test.ts` checks every table.
- **Bug fix:** add a dated test in `tests/regressions/` that fails before the fix. See the folder's README.
- **Changed response shape:** update the snapshot with `npx vitest run -u` and say why in the pull request.

## Secrets

- Never read, print or commit `.env` files, keys or tokens, and never paste them into a pull request, issue, commit message or log.
- New settings go in `.env.example` with a placeholder value.
- Nothing secret goes in a `VITE_` variable: those are sent to every visitor's browser.

## Ask a person first

Stop and ask before anything destructive or outside this repository:

- deleting data, branches or cloud resources
- running anything against production or a shared database
- changing repository settings, secrets or permissions
- adding a dependency (say what it is and why)
